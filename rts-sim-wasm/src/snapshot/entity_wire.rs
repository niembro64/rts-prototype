// Typed snapshot entity-wire packing and detail-row encoding.

use super::*;

// ===========================================================================
// Entity wire packer. Rust owns the compact `{v,m,t,b,e}` entity wire format.
// Movement-only unit deltas, split unit-turret deltas, and building hot deltas
// pack into grouped varint slabs (`m` / `t` / `b`); every other entity packs as
// a flat-array detail row (`e`). Reads the entity SoA the TS serializer already builds
// (stateSerializerEntities.ts), bulk-copied into scratch by the bridge — no
// per-entity JS->WASM crossing.
//
// SoA row layouts (must match stateSerializerEntities.ts strides/slots):
//   basic[9], unit[77], building[50], action[19], turret[13], waypoint[5].
// hp/velocity (unit) and hp/build (building) presence is NOT stored in the SoA
// (the legacy verbose encoder always emitted them); it is re-derived here as
// `isFull || (changedFields & bit)`, exactly how serializeEntitySnapshot sets
// the DTO sub-fields.
pub(crate) const V6_PACKED_ENTITIES_VERSION: u64 = 21;

pub(crate) const V6_ENTITY_FLAG_HAS_POS: u32 = 1 << 0;
pub(crate) const V6_ENTITY_FLAG_HAS_ROTATION: u32 = 1 << 1;
pub(crate) const V6_ENTITY_FLAG_HAS_CHANGED_FIELDS: u32 = 1 << 2;
pub(crate) const V6_ENTITY_FLAG_TYPE_BUILDING: u32 = 1 << 3;
pub(crate) const V6_ENTITY_FLAG_HAS_UNIT: u32 = 1 << 4;
pub(crate) const V6_ENTITY_FLAG_HAS_BUILDING: u32 = 1 << 5;

pub(crate) const V6_UNIT_FLAG_HP: u32 = 1 << 0;
pub(crate) const V6_UNIT_FLAG_VELOCITY: u32 = 1 << 1;
pub(crate) const V6_UNIT_FLAG_BLUEPRINT_CODE: u32 = 1 << 2;
pub(crate) const V6_UNIT_FLAG_RADIUS: u32 = 1 << 3;
pub(crate) const V6_UNIT_FLAG_BODY_CENTER_HEIGHT: u32 = 1 << 4;
pub(crate) const V6_UNIT_FLAG_MASS: u32 = 1 << 5;
pub(crate) const V6_UNIT_FLAG_SURFACE_NORMAL: u32 = 1 << 6;
pub(crate) const V6_UNIT_FLAG_CLOAK_STATE_PRESENT: u32 = 1 << 8;
pub(crate) const V6_UNIT_FLAG_ORIENTATION: u32 = 1 << 9;
pub(crate) const V6_UNIT_FLAG_ANGULAR_VELOCITY: u32 = 1 << 10;
pub(crate) const V6_UNIT_FLAG_IS_COMMANDER: u32 = 1 << 12;
pub(crate) const V6_UNIT_FLAG_BUILD_TARGET_ID: u32 = 1 << 13;
pub(crate) const V6_UNIT_FLAG_BUILD_TARGET_NULL: u32 = 1 << 14;
pub(crate) const V6_UNIT_FLAG_ACTIONS: u32 = 1 << 15;
pub(crate) const V6_UNIT_FLAG_TURRETS: u32 = 1 << 16;
pub(crate) const V6_UNIT_FLAG_BUILD: u32 = 1 << 17;
pub(crate) const V6_UNIT_FLAG_BUILD_COMPLETE: u32 = 1 << 18;
pub(crate) const V6_UNIT_FLAG_BUILD_INTERRUPTED: u32 = 1 << 19;
pub(crate) const V6_UNIT_FLAG_REPEAT_PRESENT: u32 = 1 << 20;
pub(crate) const V6_UNIT_FLAG_REPEAT_ENABLED: u32 = 1 << 21;
pub(crate) const V6_UNIT_FLAG_TRAJECTORY_PRESENT: u32 = 1 << 24;
pub(crate) const V6_UNIT_FLAG_TRAJECTORY_HIGH: u32 = 1 << 25;
pub(crate) const V6_UNIT_FLAG_TRAJECTORY_AUTO: u32 = 1 << 26;
pub(crate) const V6_UNIT_FLAG_MOVE_STATE_PRESENT: u32 = 1 << 27;
pub(crate) const V6_UNIT_FLAG_MOVE_STATE_HOLD: u32 = 1 << 28;
pub(crate) const V6_UNIT_FLAG_MOVE_STATE_ROAM: u32 = 1 << 29;
pub(crate) const V6_UNIT_FLAG_FIRE_STATE_PRESENT: u32 = 1 << 30;
pub(crate) const V6_UNIT_FLAG_BUILDER_PRIORITY_PRESENT: u32 = 1 << 31;

pub(crate) const V6_BUILDING_FLAG_BLUEPRINT_CODE: u32 = 1 << 0;
pub(crate) const V6_BUILDING_FLAG_DIM: u32 = 1 << 1;
pub(crate) const V6_BUILDING_FLAG_HP: u32 = 1 << 2;
pub(crate) const V6_BUILDING_FLAG_BUILD: u32 = 1 << 3;
pub(crate) const V6_BUILDING_FLAG_BUILD_COMPLETE: u32 = 1 << 4;
pub(crate) const V6_BUILDING_FLAG_METAL_EXTRACTION_RATE: u32 = 1 << 5;
pub(crate) const V6_BUILDING_FLAG_SOLAR: u32 = 1 << 6;
pub(crate) const V6_BUILDING_FLAG_SOLAR_OPEN: u32 = 1 << 7;
pub(crate) const V6_BUILDING_FLAG_TURRETS: u32 = 1 << 8;
pub(crate) const V6_BUILDING_FLAG_FACTORY: u32 = 1 << 9;
pub(crate) const V6_BUILDING_FLAG_FACTORY_PRODUCING: u32 = 1 << 10;
pub(crate) const V6_BUILDING_FLAG_BUILD_INTERRUPTED: u32 = 1 << 11;

pub(crate) const V6_MOVEMENT_FLAG_POS: u32 = 1 << 0;
pub(crate) const V6_MOVEMENT_FLAG_ROTATION: u32 = 1 << 1;
pub(crate) const V6_MOVEMENT_FLAG_VELOCITY: u32 = 1 << 2;
pub(crate) const V6_MOVEMENT_FLAG_ORIENTATION: u32 = 1 << 3;
pub(crate) const V6_MOVEMENT_FLAG_ANGULAR_VELOCITY: u32 = 1 << 4;
pub(crate) const V6_MOVEMENT_FLAG_YAW_ORIENTATION: u32 = 1 << 5;
pub(crate) const V6_MOVEMENT_FLAG_YAW_ANGULAR_VELOCITY: u32 = 1 << 6;
pub(crate) const V6_MOVEMENT_FLAG_SURFACE_NORMAL: u32 = 1 << 7;
pub(crate) const V6_MOVEMENT_FLAG_HP: u32 = 1 << 8;

pub(crate) const V6_BUILDING_DELTA_FLAG_POS: u32 = 1 << 0;
pub(crate) const V6_BUILDING_DELTA_FLAG_ROTATION: u32 = 1 << 1;
pub(crate) const V6_BUILDING_DELTA_FLAG_HP: u32 = 1 << 2;
pub(crate) const V6_BUILDING_DELTA_FLAG_BUILD: u32 = 1 << 3;

pub(crate) const V6_ACTION_FLAG_POS: u32 = 1 << 0;
pub(crate) const V6_ACTION_FLAG_POS_Z: u32 = 1 << 1;
pub(crate) const V6_ACTION_FLAG_PATH_EXP: u32 = 1 << 2;
pub(crate) const V6_ACTION_FLAG_TARGET_ID: u32 = 1 << 3;
pub(crate) const V6_ACTION_FLAG_BUILDING_BLUEPRINT_ID: u32 = 1 << 4;
pub(crate) const V6_ACTION_FLAG_GRID: u32 = 1 << 5;
pub(crate) const V6_ACTION_FLAG_BUILDING_ID: u32 = 1 << 6;
pub(crate) const V6_ACTION_FLAG_WAIT_GATHER: u32 = 1 << 7;
pub(crate) const V6_ACTION_FLAG_WAIT_GROUP_ID: u32 = 1 << 8;

pub(crate) const V6_TURRET_FLAG_TARGET_ID: u32 = 1 << 0;
pub(crate) const V6_TURRET_FLAG_SHIELD_RANGE: u32 = 1 << 1;
pub(crate) const V6_TURRET_FLAG_INACTIVE: u32 = 1 << 2;
pub(crate) const V6_TURRET_FLAG_HOST_PIECE_YAW: u32 = 1 << 3;

pub(crate) const V6_WAYPOINT_FLAG_POS_Z: u32 = 1 << 0;

pub(crate) const V6_BASIC_STRIDE: usize = 9;
pub(crate) const V6_UNIT_STRIDE: usize = 77;
pub(crate) const V6_BUILDING_STRIDE: usize = 50;

pub(crate) const V6_KIND_RAW: u32 = 0;
pub(crate) const V6_KIND_BASIC: u32 = 1;
pub(crate) const V6_KIND_UNIT: u32 = 2;
pub(crate) const V6_KIND_BUILDING: u32 = 3;
pub(crate) const V6_WIRE_TYPE_UNIT: f64 = 1.0;

#[inline]
pub(crate) fn v6_movement_changed_mask() -> u32 {
    ENTITY_CHANGED_POS
        | ENTITY_CHANGED_ROT
        | ENTITY_CHANGED_VEL
        | ENTITY_CHANGED_NORMAL
        | ENTITY_CHANGED_HP
}

#[inline]
pub(crate) fn v6_building_delta_changed_mask() -> u32 {
    ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT | ENTITY_CHANGED_HP | ENTITY_CHANGED_BUILDING
}

// --- Input scratch (bulk-filled by the TS bridge from entityWireSource) ---
#[derive(Default)]
pub(crate) struct SnapshotEncodeV6InputScratch {
    kinds: Vec<u32>,
    row_indices: Vec<u32>,
    basic: Vec<f64>,
    unit: Vec<f64>,
    building: Vec<f64>,
    /// Pre-encoded MessagePack values for RAW (private-detail DTO) rows,
    /// concatenated in entity-index order. Spans are (offset, len) u32
    /// pairs, one per RAW row in the same order.
    raw_bytes: Vec<u8>,
    raw_spans: Vec<u32>,
}

pub(crate) static SNAPSHOT_ENCODE_V6_INPUT_SCRATCH: WasmLazy<SnapshotEncodeV6InputScratch> =
    WasmLazy::new();

#[inline]
pub(crate) fn snapshot_encode_v6_input_scratch() -> &'static mut SnapshotEncodeV6InputScratch {
    SNAPSHOT_ENCODE_V6_INPUT_SCRATCH.get_or_init(SnapshotEncodeV6InputScratch::default)
}

#[wasm_bindgen]
pub fn snapshot_encode_v6_kinds_scratch_ptr() -> *const u32 {
    snapshot_encode_v6_input_scratch().kinds.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_kinds_scratch_ensure(count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    if s.kinds.len() < count as usize {
        s.kinds.resize(count as usize, 0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_row_indices_scratch_ptr() -> *const u32 {
    snapshot_encode_v6_input_scratch().row_indices.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_row_indices_scratch_ensure(count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    if s.row_indices.len() < count as usize {
        s.row_indices.resize(count as usize, 0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_basic_scratch_ptr() -> *const f64 {
    snapshot_encode_v6_input_scratch().basic.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_basic_scratch_ensure(row_count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    let needed = row_count as usize * V6_BASIC_STRIDE;
    if s.basic.len() < needed {
        s.basic.resize(needed, 0.0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_unit_scratch_ptr() -> *const f64 {
    snapshot_encode_v6_input_scratch().unit.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_unit_scratch_ensure(row_count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    let needed = row_count as usize * V6_UNIT_STRIDE;
    if s.unit.len() < needed {
        s.unit.resize(needed, 0.0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_building_scratch_ptr() -> *const f64 {
    snapshot_encode_v6_input_scratch().building.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_building_scratch_ensure(row_count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    let needed = row_count as usize * V6_BUILDING_STRIDE;
    if s.building.len() < needed {
        s.building.resize(needed, 0.0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_raw_bytes_scratch_ptr() -> *const u8 {
    snapshot_encode_v6_input_scratch().raw_bytes.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_raw_bytes_scratch_ensure(byte_len: u32) {
    let s = snapshot_encode_v6_input_scratch();
    if s.raw_bytes.len() < byte_len as usize {
        s.raw_bytes.resize(byte_len as usize, 0);
    }
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_raw_spans_scratch_ptr() -> *const u32 {
    snapshot_encode_v6_input_scratch().raw_spans.as_ptr()
}
#[wasm_bindgen]
pub fn snapshot_encode_v6_raw_spans_scratch_ensure(raw_row_count: u32) {
    let s = snapshot_encode_v6_input_scratch();
    let needed = raw_row_count as usize * 2;
    if s.raw_spans.len() < needed {
        s.raw_spans.resize(needed, 0);
    }
}

// --- Work scratch (grouped slab builders + detail-row index list) ---
#[derive(Default)]
pub(crate) struct V6MovementGroup {
    flags: u32,
    player_id: u32,
    count: u32,
    last_id: i64,
    writer: PackedBinaryWriter,
}

#[derive(Default)]
pub(crate) struct V6TurretGroup {
    player_id: u32,
    turret_count: u32,
    count: u32,
    last_id: i64,
    writer: PackedBinaryWriter,
}

#[derive(Default)]
pub(crate) struct V6BuildingDeltaGroup {
    flags: u32,
    player_id: u32,
    count: u32,
    last_id: i64,
    writer: PackedBinaryWriter,
}

#[derive(Default)]
pub(crate) struct SnapshotEncodeV6WorkScratch {
    movement_groups: Vec<V6MovementGroup>,
    movement_group_count: usize,
    movement_row_count: u32,
    turret_groups: Vec<V6TurretGroup>,
    turret_group_count: usize,
    turret_row_count: u32,
    building_groups: Vec<V6BuildingDeltaGroup>,
    building_group_count: usize,
    building_row_count: u32,
    m_out: PackedBinaryWriter,
    t_out: PackedBinaryWriter,
    b_out: PackedBinaryWriter,
    detail: Vec<u32>,
}

impl SnapshotEncodeV6WorkScratch {
    pub(crate) fn reset(&mut self) {
        self.movement_group_count = 0;
        self.movement_row_count = 0;
        self.turret_group_count = 0;
        self.turret_row_count = 0;
        self.building_group_count = 0;
        self.building_row_count = 0;
        self.detail.clear();
    }

    pub(crate) fn movement_group_index(&mut self, flags: u32, player_id: u32) -> usize {
        for i in 0..self.movement_group_count {
            let g = &self.movement_groups[i];
            if g.flags == flags && g.player_id == player_id {
                return i;
            }
        }
        let index = self.movement_group_count;
        if index == self.movement_groups.len() {
            self.movement_groups.push(V6MovementGroup::default());
        }
        let g = &mut self.movement_groups[index];
        g.flags = flags;
        g.player_id = player_id;
        g.count = 0;
        g.last_id = 0;
        g.writer.reset(0);
        self.movement_group_count += 1;
        index
    }

    pub(crate) fn turret_group_index(&mut self, player_id: u32, turret_count: u32) -> usize {
        for i in 0..self.turret_group_count {
            let g = &self.turret_groups[i];
            if g.player_id == player_id && g.turret_count == turret_count {
                return i;
            }
        }
        let index = self.turret_group_count;
        if index == self.turret_groups.len() {
            self.turret_groups.push(V6TurretGroup::default());
        }
        let g = &mut self.turret_groups[index];
        g.player_id = player_id;
        g.turret_count = turret_count;
        g.count = 0;
        g.last_id = 0;
        g.writer.reset(0);
        self.turret_group_count += 1;
        index
    }

    pub(crate) fn building_group_index(&mut self, flags: u32, player_id: u32) -> usize {
        for i in 0..self.building_group_count {
            let g = &self.building_groups[i];
            if g.flags == flags && g.player_id == player_id {
                return i;
            }
        }
        let index = self.building_group_count;
        if index == self.building_groups.len() {
            self.building_groups.push(V6BuildingDeltaGroup::default());
        }
        let g = &mut self.building_groups[index];
        g.flags = flags;
        g.player_id = player_id;
        g.count = 0;
        g.last_id = 0;
        g.writer.reset(0);
        self.building_group_count += 1;
        index
    }
}

pub(crate) static SNAPSHOT_ENCODE_V6_WORK_SCRATCH: WasmLazy<SnapshotEncodeV6WorkScratch> =
    WasmLazy::new();

#[inline]
pub(crate) fn snapshot_encode_v6_work_scratch() -> &'static mut SnapshotEncodeV6WorkScratch {
    SNAPSHOT_ENCODE_V6_WORK_SCRATCH.get_or_init(SnapshotEncodeV6WorkScratch::default)
}

#[inline]
pub(crate) fn v6_present(is_full: bool, cf: u32, bit: u32) -> bool {
    is_full || (cf & bit) != 0
}

pub(crate) fn v6_is_movement_only(
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
) -> bool {
    let mask = v6_movement_changed_mask();
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        if input.basic[base + 1] != V6_WIRE_TYPE_UNIT {
            return false;
        }
        if input.basic[base + 7] == 0.0 {
            return false; // full-state row: not movement-only.
        }
        let cf = input.basic[base + 8] as u32;
        if cf == 0 || (cf & !mask) != 0 {
            return false;
        }
        if (cf & ENTITY_CHANGED_NORMAL) != 0 {
            return false;
        }
        if (cf & ENTITY_CHANGED_HP) != 0 {
            return false;
        }
        return true;
    }
    if kind == V6_KIND_UNIT {
        let base = row * V6_UNIT_STRIDE;
        if input.unit[base + 6] == 0.0 {
            return false;
        }
        let cf = input.unit[base + 7] as u32;
        if cf == 0 || (cf & !mask) != 0 {
            return false;
        }
        // All non-movement unit sub-fields must be absent.
        if input.unit[base + 13] != 0.0
            || input.unit[base + 15] != 0.0
            || input.unit[base + 19] != 0.0
            || input.unit[base + 21] != 0.0
            || input.unit[base + 36] != 0.0
            || input.unit[base + 37] != 0.0
            || input.unit[base + 38] != 0.0
            || input.unit[base + 41] != 0.0
            || input.unit[base + 43] != 0.0
            || input.unit[base + 45] != 0.0
            || input.unit[base + 51] != 0.0
            || input.unit[base + 53] != 0.0
            || input.unit[base + 55] != 0.0
            || input.unit[base + 57] != 0.0
            || input.unit[base + 59] != 0.0
            || input.unit[base + 61] != 0.0
            || input.unit[base + 63] != 0.0
            || input.unit[base + 68] != 0.0
        {
            return false;
        }
        if input.unit[base + 27] != 0.0 && (cf & ENTITY_CHANGED_ROT) == 0 {
            return false;
        }
        if input.unit[base + 32] != 0.0 && (cf & ENTITY_CHANGED_VEL) == 0 {
            return false;
        }
        if input.unit[base + 23] != 0.0 && (cf & ENTITY_CHANGED_NORMAL) == 0 {
            return false;
        }
        return true;
    }
    false
}

pub(crate) fn v6_is_split_turret(
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
) -> bool {
    if kind != V6_KIND_UNIT {
        return false;
    }
    let base = row * V6_UNIT_STRIDE;
    if input.unit[base + 6] == 0.0 {
        return false;
    }
    let cf = input.unit[base + 7] as u32;
    if cf == 0 || (cf & ENTITY_CHANGED_TURRETS) == 0 {
        return false;
    }
    let mask = v6_movement_changed_mask() | ENTITY_CHANGED_TURRETS;
    if (cf & !mask) != 0 {
        return false;
    }
    if input.unit[base + 43] == 0.0 {
        return false; // turrets must be present
    }
    if input.unit[base + 13] != 0.0
        || input.unit[base + 15] != 0.0
        || input.unit[base + 19] != 0.0
        || input.unit[base + 21] != 0.0
        || input.unit[base + 36] != 0.0
        || input.unit[base + 37] != 0.0
        || input.unit[base + 38] != 0.0
        || input.unit[base + 41] != 0.0
        || input.unit[base + 45] != 0.0
        || input.unit[base + 51] != 0.0
        || input.unit[base + 53] != 0.0
        || input.unit[base + 55] != 0.0
        || input.unit[base + 57] != 0.0
        || input.unit[base + 59] != 0.0
        || input.unit[base + 61] != 0.0
        || input.unit[base + 63] != 0.0
        || input.unit[base + 68] != 0.0
    {
        return false;
    }
    if input.unit[base + 27] != 0.0 && (cf & ENTITY_CHANGED_ROT) == 0 {
        return false;
    }
    if input.unit[base + 32] != 0.0 && (cf & ENTITY_CHANGED_VEL) == 0 {
        return false;
    }
    if input.unit[base + 23] != 0.0 && (cf & ENTITY_CHANGED_NORMAL) == 0 {
        return false;
    }
    true
}

pub(crate) fn v6_has_movement_fields(input: &SnapshotEncodeV6InputScratch, row: usize) -> bool {
    let base = row * V6_UNIT_STRIDE;
    let cf = input.unit[base + 7] as u32;
    (cf & ENTITY_CHANGED_POS) != 0
        || (cf & ENTITY_CHANGED_ROT) != 0
        || (cf & ENTITY_CHANGED_VEL) != 0
        || (cf & ENTITY_CHANGED_NORMAL) != 0
        || (cf & ENTITY_CHANGED_HP) != 0
        || input.unit[base + 27] != 0.0
        || input.unit[base + 32] != 0.0
}

pub(crate) fn v6_is_building_delta(
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
) -> bool {
    let mask = v6_building_delta_changed_mask();
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        if input.basic[base + 1] == V6_WIRE_TYPE_UNIT {
            return false;
        }
        if input.basic[base + 7] == 0.0 {
            return false;
        }
        let cf = input.basic[base + 8] as u32;
        let basic_mask = ENTITY_CHANGED_POS | ENTITY_CHANGED_ROT;
        return cf != 0 && (cf & !basic_mask) == 0;
    }
    if kind != V6_KIND_BUILDING {
        return false;
    }
    let base = row * V6_BUILDING_STRIDE;
    if input.building[base + 6] == 0.0 {
        return false;
    }
    let cf = input.building[base + 7] as u32;
    if cf == 0 || (cf & !mask) != 0 {
        return false;
    }
    // Full/static metadata, turrets, factories, extractor rates, and
    // active-state changes still need the detail row shape.
    if input.building[base + 8] != 0.0
        || input.building[base + 10] != 0.0
        || input.building[base + 18] != 0.0
        || input.building[base + 20] != 0.0
        || input.building[base + 22] != 0.0
        || input.building[base + 24] != 0.0
    {
        return false;
    }
    true
}

pub(crate) fn v6_building_delta_flags(
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
) -> u32 {
    let cf = if kind == V6_KIND_BASIC {
        input.basic[row * V6_BASIC_STRIDE + 8] as u32
    } else {
        input.building[row * V6_BUILDING_STRIDE + 7] as u32
    };
    let mut flags = 0u32;
    if (cf & ENTITY_CHANGED_POS) != 0 {
        flags |= V6_BUILDING_DELTA_FLAG_POS;
    }
    if (cf & ENTITY_CHANGED_ROT) != 0 {
        flags |= V6_BUILDING_DELTA_FLAG_ROTATION;
    }
    if (cf & ENTITY_CHANGED_HP) != 0 {
        flags |= V6_BUILDING_DELTA_FLAG_HP;
    }
    if (cf & ENTITY_CHANGED_BUILDING) != 0 {
        flags |= V6_BUILDING_DELTA_FLAG_BUILD;
    }
    flags
}

pub(crate) fn v6_write_building_delta_payload(
    writer: &mut PackedBinaryWriter,
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
    flags: u32,
) {
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        if (flags & V6_BUILDING_DELTA_FLAG_POS) != 0 {
            writer.write_var_int_from_f64(input.basic[base + 2]);
            writer.write_var_int_from_f64(input.basic[base + 3]);
            writer.write_var_int_from_f64(input.basic[base + 4]);
        }
        if (flags & V6_BUILDING_DELTA_FLAG_ROTATION) != 0 {
            writer.write_var_int_from_f64(input.basic[base + 5]);
        }
        return;
    }

    let base = row * V6_BUILDING_STRIDE;
    if (flags & V6_BUILDING_DELTA_FLAG_POS) != 0 {
        writer.write_var_int_from_f64(input.building[base + 1]);
        writer.write_var_int_from_f64(input.building[base + 2]);
        writer.write_var_int_from_f64(input.building[base + 3]);
    }
    if (flags & V6_BUILDING_DELTA_FLAG_ROTATION) != 0 {
        writer.write_var_int_from_f64(input.building[base + 4]);
    }
    if (flags & V6_BUILDING_DELTA_FLAG_HP) != 0 {
        writer.write_f64_le(input.building[base + 13]);
        writer.write_f64_le(input.building[base + 14]);
    }
    if (flags & V6_BUILDING_DELTA_FLAG_BUILD) != 0 {
        writer.write_var_uint(if input.building[base + 15] != 0.0 {
            1
        } else {
            0
        });
        writer.write_var_uint(if input.building[base + 34] != 0.0 {
            1
        } else {
            0
        });
        writer.write_f64_le(input.building[base + 16]);
        writer.write_f64_le(input.building[base + 17]);
    }
}

#[inline]
pub(crate) fn v6_can_compact_yaw_orientation(
    rot_present: bool,
    x: f64,
    y: f64,
    z: f64,
    w: f64,
) -> bool {
    rot_present
        && x == 0.0
        && y == 0.0
        && z.is_finite()
        && w.is_finite()
        && z.abs() <= 1.000001
        && w.abs() <= 1.000001
}

pub(crate) fn v6_movement_flags(
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
) -> u32 {
    let mut flags = 0u32;
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        let is_full = input.basic[base + 7] == 0.0;
        let cf = input.basic[base + 8] as u32;
        if v6_present(is_full, cf, ENTITY_CHANGED_POS) {
            flags |= V6_MOVEMENT_FLAG_POS;
        }
        if v6_present(is_full, cf, ENTITY_CHANGED_ROT) {
            flags |= V6_MOVEMENT_FLAG_ROTATION;
        }
        return flags;
    }
    let base = row * V6_UNIT_STRIDE;
    let is_full = input.unit[base + 6] == 0.0;
    let cf = input.unit[base + 7] as u32;
    let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
    if v6_present(is_full, cf, ENTITY_CHANGED_POS) {
        flags |= V6_MOVEMENT_FLAG_POS;
    }
    if rot_present {
        flags |= V6_MOVEMENT_FLAG_ROTATION;
    }
    if v6_present(is_full, cf, ENTITY_CHANGED_VEL) {
        flags |= V6_MOVEMENT_FLAG_VELOCITY;
    }
    if input.unit[base + 23] != 0.0 {
        flags |= V6_MOVEMENT_FLAG_SURFACE_NORMAL;
    }
    if v6_present(is_full, cf, ENTITY_CHANGED_HP) {
        flags |= V6_MOVEMENT_FLAG_HP;
    }
    if input.unit[base + 27] != 0.0 {
        let compact = v6_can_compact_yaw_orientation(
            rot_present,
            input.unit[base + 28],
            input.unit[base + 29],
            input.unit[base + 30],
            input.unit[base + 31],
        );
        flags |= if compact {
            V6_MOVEMENT_FLAG_YAW_ORIENTATION
        } else {
            V6_MOVEMENT_FLAG_ORIENTATION
        };
    }
    if input.unit[base + 32] != 0.0 {
        let compact = input.unit[base + 33] == 0.0 && input.unit[base + 34] == 0.0;
        flags |= if compact {
            V6_MOVEMENT_FLAG_YAW_ANGULAR_VELOCITY
        } else {
            V6_MOVEMENT_FLAG_ANGULAR_VELOCITY
        };
    }
    flags
}

pub(crate) fn v6_write_movement_payload(
    writer: &mut PackedBinaryWriter,
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
    flags: u32,
) {
    if kind == V6_KIND_BASIC {
        let base = row * V6_BASIC_STRIDE;
        if (flags & V6_MOVEMENT_FLAG_POS) != 0 {
            writer.write_var_int_from_f64(input.basic[base + 2]);
            writer.write_var_int_from_f64(input.basic[base + 3]);
            writer.write_var_int_from_f64(input.basic[base + 4]);
        }
        if (flags & V6_MOVEMENT_FLAG_ROTATION) != 0 {
            writer.write_var_int_from_f64(input.basic[base + 5]);
        }
        return;
    }
    let base = row * V6_UNIT_STRIDE;
    if (flags & V6_MOVEMENT_FLAG_POS) != 0 {
        writer.write_var_int_from_f64(input.unit[base + 1]);
        writer.write_var_int_from_f64(input.unit[base + 2]);
        writer.write_var_int_from_f64(input.unit[base + 3]);
    }
    if (flags & V6_MOVEMENT_FLAG_ROTATION) != 0 {
        writer.write_var_int_from_f64(input.unit[base + 4]);
    }
    if (flags & V6_MOVEMENT_FLAG_VELOCITY) != 0 {
        writer.write_var_int_from_f64(input.unit[base + 10]);
        writer.write_var_int_from_f64(input.unit[base + 11]);
        writer.write_var_int_from_f64(input.unit[base + 12]);
    }
    if (flags & V6_MOVEMENT_FLAG_SURFACE_NORMAL) != 0 {
        writer.write_var_int_from_f64(input.unit[base + 24]);
        writer.write_var_int_from_f64(input.unit[base + 25]);
        writer.write_var_int_from_f64(input.unit[base + 26]);
    }
    if (flags & V6_MOVEMENT_FLAG_HP) != 0 {
        writer.write_f64_le(input.unit[base + 8]);
        writer.write_f64_le(input.unit[base + 9]);
    }
    if (flags & V6_MOVEMENT_FLAG_ORIENTATION) != 0 {
        writer.write_f64_le(input.unit[base + 28]);
        writer.write_f64_le(input.unit[base + 29]);
        writer.write_f64_le(input.unit[base + 30]);
        writer.write_f64_le(input.unit[base + 31]);
    }
    if (flags & V6_MOVEMENT_FLAG_ANGULAR_VELOCITY) != 0 {
        writer.write_f64_le(input.unit[base + 33]);
        writer.write_f64_le(input.unit[base + 34]);
        writer.write_f64_le(input.unit[base + 35]);
    }
    if (flags & V6_MOVEMENT_FLAG_YAW_ANGULAR_VELOCITY) != 0 {
        writer.write_f64_le(input.unit[base + 35]);
    }
}

pub(crate) fn v6_write_turret_payload(
    writer: &mut PackedBinaryWriter,
    turret_buf: &[f64],
    turret_offset: usize,
    turret_count: usize,
) {
    for t in 0..turret_count {
        let tb = (turret_offset + t) * SNAPSHOT_ENCODE_TURRET_STRIDE;
        let has_target = turret_buf[tb + 6] != 0.0;
        let has_ffr = turret_buf[tb + 8] != 0.0;
        let inactive = turret_buf[tb + 10] != 0.0;
        let mut flags = 0u32;
        if has_target {
            flags |= V6_TURRET_FLAG_TARGET_ID;
        }
        if has_ffr {
            flags |= V6_TURRET_FLAG_SHIELD_RANGE;
        }
        if inactive {
            flags |= V6_TURRET_FLAG_INACTIVE;
        }
        flags |= V6_TURRET_FLAG_HOST_PIECE_YAW;
        writer.write_var_uint(flags as u64);
        writer.write_var_uint(turret_buf[tb + 4] as u64); // id
        writer.write_var_uint(turret_buf[tb + 5] as u64); // state
        writer.write_var_int_from_f64(turret_buf[tb + 0]); // rot
        writer.write_var_int_from_f64(turret_buf[tb + 1]); // vel
        writer.write_var_int_from_f64(turret_buf[tb + 2]); // pitch
        writer.write_var_int_from_f64(turret_buf[tb + 3]); // pitchVel
        writer.write_var_int_from_f64(turret_buf[tb + 11]); // hostYaw (flagged)
        writer.write_var_int_from_f64(turret_buf[tb + 12]); // hostYawVel (flagged)
        if has_target {
            writer.write_var_uint(turret_buf[tb + 7] as u64);
        }
        if has_ffr {
            writer.write_f64_le(turret_buf[tb + 9]);
        }
    }
}

pub(crate) fn v6_write_detail_action(w: &mut MessagePackWriter, action_buf: &[f64], a_row: usize) {
    let base = a_row * SNAPSHOT_ENCODE_ACTION_STRIDE;
    let has_pos = action_buf[base + 1] != 0.0;
    let has_pos_z = action_buf[base + 4] != 0.0;
    let path_exp = action_buf[base + 6] != 0.0;
    let has_target = action_buf[base + 7] != 0.0;
    let has_building_type = action_buf[base + 9] != 0.0;
    let has_grid = action_buf[base + 11] != 0.0;
    let has_building_id = action_buf[base + 14] != 0.0;
    let wait_gather = action_buf[base + 16] != 0.0;
    let has_wait_group_id = action_buf[base + 17] != 0.0;
    let mut flags = 0u32;
    if has_pos {
        flags |= V6_ACTION_FLAG_POS;
    }
    if has_pos_z {
        flags |= V6_ACTION_FLAG_POS_Z;
    }
    if path_exp {
        flags |= V6_ACTION_FLAG_PATH_EXP;
    }
    if has_target {
        flags |= V6_ACTION_FLAG_TARGET_ID;
    }
    if has_building_type {
        flags |= V6_ACTION_FLAG_BUILDING_BLUEPRINT_ID;
    }
    if has_grid {
        flags |= V6_ACTION_FLAG_GRID;
    }
    if has_building_id {
        flags |= V6_ACTION_FLAG_BUILDING_ID;
    }
    if wait_gather {
        flags |= V6_ACTION_FLAG_WAIT_GATHER;
    }
    if has_wait_group_id {
        flags |= V6_ACTION_FLAG_WAIT_GROUP_ID;
    }
    let mut len = 2usize; // flags, type
    if has_pos {
        len += 2;
    }
    if has_pos_z {
        len += 1;
    }
    if has_target {
        len += 1;
    }
    if has_building_type {
        len += 1;
    }
    if has_grid {
        len += 2;
    }
    if has_building_id {
        len += 1;
    }
    if has_wait_group_id {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(flags as f64);
    w.write_number(action_buf[base + 0]); // type
    if has_pos {
        w.write_number(action_buf[base + 2]);
        w.write_number(action_buf[base + 3]);
    }
    if has_pos_z {
        w.write_number(action_buf[base + 5]);
    }
    if has_target {
        w.write_number(action_buf[base + 8]);
    }
    if has_building_type {
        write_string_from_scratch(w, action_buf[base + 10] as u32);
    }
    if has_grid {
        w.write_number(action_buf[base + 12]);
        w.write_number(action_buf[base + 13]);
    }
    if has_building_id {
        w.write_number(action_buf[base + 15]);
    }
    if has_wait_group_id {
        w.write_number(action_buf[base + 18]);
    }
}

pub(crate) fn v6_write_detail_turret(w: &mut MessagePackWriter, turret_buf: &[f64], t_row: usize) {
    let base = t_row * SNAPSHOT_ENCODE_TURRET_STRIDE;
    let has_target = turret_buf[base + 6] != 0.0;
    let has_ffr = turret_buf[base + 8] != 0.0;
    let inactive = turret_buf[base + 10] != 0.0;
    let mut flags = 0u32;
    if has_target {
        flags |= V6_TURRET_FLAG_TARGET_ID;
    }
    if has_ffr {
        flags |= V6_TURRET_FLAG_SHIELD_RANGE;
    }
    if inactive {
        flags |= V6_TURRET_FLAG_INACTIVE;
    }
    flags |= V6_TURRET_FLAG_HOST_PIECE_YAW;
    let mut len = 9usize; // base 7 + flagged hostYaw/hostYawVel
    if has_target {
        len += 1;
    }
    if has_ffr {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(flags as f64);
    w.write_number(turret_buf[base + 4]); // id
    w.write_number(turret_buf[base + 5]); // state
    w.write_number(turret_buf[base + 0]); // rot
    w.write_number(turret_buf[base + 1]); // vel
    w.write_number(turret_buf[base + 2]); // pitch
    w.write_number(turret_buf[base + 3]); // pitchVel
    w.write_number(turret_buf[base + 11]); // hostYaw
    w.write_number(turret_buf[base + 12]); // hostYawVel
    if has_target {
        w.write_number(turret_buf[base + 7]);
    }
    if has_ffr {
        w.write_number(turret_buf[base + 9]);
    }
}

pub(crate) fn v6_write_detail_waypoint(
    w: &mut MessagePackWriter,
    waypoint_buf: &[f64],
    wp_row: usize,
    waypoint_string_base: u32,
) {
    let base = wp_row * SNAPSHOT_ENCODE_WAYPOINT_STRIDE;
    let has_pos_z = waypoint_buf[base + 2] != 0.0;
    let mut len = 4usize;
    if has_pos_z {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(if has_pos_z {
        V6_WAYPOINT_FLAG_POS_Z as f64
    } else {
        0.0
    });
    w.write_number(waypoint_buf[base + 0]); // pos.x
    w.write_number(waypoint_buf[base + 1]); // pos.y
    write_string_from_scratch(w, waypoint_string_base + waypoint_buf[base + 4] as u32);
    if has_pos_z {
        w.write_number(waypoint_buf[base + 3]);
    }
}

pub(crate) fn v6_write_detail_factory(
    w: &mut MessagePackWriter,
    building_buf: &[f64],
    base: usize,
    queue_buf: &[u32],
    waypoint_buf: &[f64],
    waypoint_string_base: u32,
) {
    w.write_array_header(15);
    // selectedUnitBlueprintCode: code or nil
    let selected_count = building_buf[base + 25] as usize;
    let selected_offset = building_buf[base + 32] as i64;
    if selected_count > 0 && selected_offset >= 0 {
        let off = selected_offset as usize;
        w.write_number(queue_buf[off] as f64);
    } else {
        w.write_nil();
    }
    w.write_number(building_buf[base + 26]); // progress
    w.write_number(building_buf[base + 28]); // energyRate
    w.write_number(building_buf[base + 29]); // metalRate
                                             // rally
    let wp_count = building_buf[base + 30] as usize;
    let wp_offset = building_buf[base + 33] as i64;
    if wp_count > 0 && wp_offset >= 0 {
        let off = wp_offset as usize;
        v6_write_detail_waypoint(w, waypoint_buf, off, waypoint_string_base);
    } else {
        w.write_nil();
    }

    let route_count = building_buf[base + 41] as i64;
    let route_offset = building_buf[base + 40] as i64;
    if route_count >= 0 {
        let count = route_count as usize;
        w.write_array_header(count);
        if route_offset >= 0 {
            let off = route_offset as usize;
            for r in 0..count {
                v6_write_detail_waypoint(w, waypoint_buf, off + r, waypoint_string_base);
            }
        }
    } else {
        w.write_nil();
    }

    if building_buf[base + 35] != 0.0 {
        w.write_number(building_buf[base + 36]);
    } else {
        w.write_nil();
    }

    w.write_number(building_buf[base + 37]);

    let finite_queue_count = building_buf[base + 39] as i64;
    let finite_queue_offset = building_buf[base + 38] as i64;
    if finite_queue_count >= 0 {
        let count = finite_queue_count as usize;
        w.write_array_header(count);
        if finite_queue_offset >= 0 {
            let off = finite_queue_offset as usize;
            for q in 0..count {
                w.write_number(queue_buf[off + q] as f64);
            }
        }
    } else {
        w.write_nil();
    }

    let quota_count = building_buf[base + 43] as i64;
    let quota_offset = building_buf[base + 42] as i64;
    if quota_count >= 0 {
        let count = quota_count as usize;
        w.write_array_header(count);
        if quota_offset >= 0 {
            let off = quota_offset as usize;
            for q in 0..count {
                w.write_number(queue_buf[off + q] as f64);
            }
        }
    } else {
        w.write_nil();
    }

    let quota_count_count = building_buf[base + 45] as i64;
    let quota_count_offset = building_buf[base + 44] as i64;
    if quota_count_count >= 0 {
        let count = quota_count_count as usize;
        w.write_array_header(count);
        if quota_count_offset >= 0 {
            let off = quota_count_offset as usize;
            for q in 0..count {
                w.write_number(queue_buf[off + q] as f64);
            }
        }
    } else {
        w.write_nil();
    }

    w.write_number(if building_buf[base + 46] != 0.0 {
        1.0
    } else {
        0.0
    });
    w.write_number(if building_buf[base + 47] != 0.0 {
        1.0
    } else {
        0.0
    });
    let move_state_code = building_buf[base + 48] as u32;
    if move_state_code == 2 {
        w.write_str("roam");
    } else if move_state_code == 1 {
        w.write_str("holdPosition");
    } else {
        w.write_str("maneuver");
    }
    if building_buf[base + 49] != 0.0 {
        w.write_str("fly");
    } else {
        w.write_str("land");
    }
}

pub(crate) fn v6_write_detail_unit(
    w: &mut MessagePackWriter,
    unit_buf: &[f64],
    base: usize,
    turret_buf: &[f64],
    action_buf: &[f64],
) {
    let is_full = unit_buf[base + 6] == 0.0;
    let cf = unit_buf[base + 7] as u32;
    let hp_present = v6_present(is_full, cf, ENTITY_CHANGED_HP);
    let vel_present = v6_present(is_full, cf, ENTITY_CHANGED_VEL);
    let has_unit_type = unit_buf[base + 13] != 0.0;
    let has_radius = unit_buf[base + 15] != 0.0;
    let has_bch = unit_buf[base + 19] != 0.0;
    let has_mass = unit_buf[base + 21] != 0.0;
    let has_surface_normal = unit_buf[base + 23] != 0.0;
    let has_orientation = unit_buf[base + 27] != 0.0;
    let has_angular_velocity = unit_buf[base + 32] != 0.0;
    let is_commander = unit_buf[base + 37] != 0.0;
    let build_target_present = unit_buf[base + 38] != 0.0;
    let build_target_null = unit_buf[base + 39] != 0.0;
    let has_actions = unit_buf[base + 41] != 0.0;
    let has_turrets = unit_buf[base + 43] != 0.0;
    let has_build = unit_buf[base + 45] != 0.0;
    let build_complete = unit_buf[base + 46] != 0.0;
    let has_fire_state = unit_buf[base + 51] != 0.0;
    let repeat_present = unit_buf[base + 53] != 0.0;
    let repeat_enabled = unit_buf[base + 54] != 0.0;
    let trajectory_present = unit_buf[base + 57] != 0.0;
    let trajectory_code = unit_buf[base + 58] as u32;
    let move_state_present = unit_buf[base + 59] != 0.0;
    let move_state_code = unit_buf[base + 60] as u32;
    let cloak_present = unit_buf[base + 61] != 0.0;
    let build_interrupted = unit_buf[base + 63] != 0.0;
    let carrier_spawn_present = unit_buf[base + 64] != 0.0;
    let builder_priority_present = unit_buf[base + 66] != 0.0;
    let builder_priority_low = unit_buf[base + 67] != 0.0;
    let has_work_station = unit_buf[base + 68] != 0.0;

    let mut flags = 0u32;
    if hp_present {
        flags |= V6_UNIT_FLAG_HP;
    }
    if vel_present {
        flags |= V6_UNIT_FLAG_VELOCITY;
    }
    if has_unit_type {
        flags |= V6_UNIT_FLAG_BLUEPRINT_CODE;
    }
    if has_radius {
        flags |= V6_UNIT_FLAG_RADIUS;
    }
    if has_bch {
        flags |= V6_UNIT_FLAG_BODY_CENTER_HEIGHT;
    }
    if has_mass {
        flags |= V6_UNIT_FLAG_MASS;
    }
    if has_surface_normal {
        flags |= V6_UNIT_FLAG_SURFACE_NORMAL;
    }
    if has_orientation {
        flags |= V6_UNIT_FLAG_ORIENTATION;
    }
    if has_angular_velocity {
        flags |= V6_UNIT_FLAG_ANGULAR_VELOCITY;
    }
    if has_fire_state {
        flags |= V6_UNIT_FLAG_FIRE_STATE_PRESENT;
    }
    if trajectory_present {
        flags |= V6_UNIT_FLAG_TRAJECTORY_PRESENT;
        if trajectory_code == 1 {
            flags |= V6_UNIT_FLAG_TRAJECTORY_HIGH;
        } else if trajectory_code == 2 {
            flags |= V6_UNIT_FLAG_TRAJECTORY_AUTO;
        }
    }
    if repeat_present {
        flags |= V6_UNIT_FLAG_REPEAT_PRESENT;
        if repeat_enabled {
            flags |= V6_UNIT_FLAG_REPEAT_ENABLED;
        }
    }
    if move_state_present {
        flags |= V6_UNIT_FLAG_MOVE_STATE_PRESENT;
        if move_state_code == 1 {
            flags |= V6_UNIT_FLAG_MOVE_STATE_HOLD;
        } else if move_state_code == 2 {
            flags |= V6_UNIT_FLAG_MOVE_STATE_ROAM;
        }
    }
    if cloak_present {
        flags |= V6_UNIT_FLAG_CLOAK_STATE_PRESENT;
    }
    if is_commander {
        flags |= V6_UNIT_FLAG_IS_COMMANDER;
    }
    if build_target_present {
        flags |= V6_UNIT_FLAG_BUILD_TARGET_ID;
        if build_target_null {
            flags |= V6_UNIT_FLAG_BUILD_TARGET_NULL;
        }
    }
    if has_actions {
        flags |= V6_UNIT_FLAG_ACTIONS;
    }
    if has_turrets {
        flags |= V6_UNIT_FLAG_TURRETS;
    }
    if has_build {
        flags |= V6_UNIT_FLAG_BUILD;
        if build_complete {
            flags |= V6_UNIT_FLAG_BUILD_COMPLETE;
        }
        if build_interrupted {
            flags |= V6_UNIT_FLAG_BUILD_INTERRUPTED;
        }
    }
    if builder_priority_present {
        flags |= V6_UNIT_FLAG_BUILDER_PRIORITY_PRESENT;
    }

    let mut len = 1usize;
    if hp_present {
        len += 2;
    }
    if vel_present {
        len += 3;
    }
    if has_unit_type {
        len += 1;
    }
    if has_radius {
        len += 3;
    }
    if has_bch {
        len += 1;
    }
    if has_mass {
        len += 1;
    }
    if has_surface_normal {
        len += 3;
    }
    if has_orientation {
        len += 4;
    }
    if has_angular_velocity {
        len += 3;
    }
    if has_fire_state {
        len += 1;
    }
    if cloak_present {
        len += 1;
    }
    if build_target_present && !build_target_null {
        len += 1;
    }
    if has_actions {
        len += 1;
    }
    if has_turrets {
        len += 1;
    }
    if has_build {
        len += 2;
    }
    if builder_priority_present {
        len += 1;
    }
    if carrier_spawn_present {
        len += 1;
    }
    if has_work_station {
        // The legacy carrier bit is an unflagged trailing value. Emit its
        // default first when the work-station extension is the only trailer,
        // then an extension mask and the eight QueryWork pose fields.
        if !carrier_spawn_present {
            len += 1;
        }
        len += 9;
    }

    w.write_array_header(len);
    w.write_number(flags as f64);
    if hp_present {
        w.write_number(unit_buf[base + 8]);
        w.write_number(unit_buf[base + 9]);
    }
    if vel_present {
        w.write_number(unit_buf[base + 10]);
        w.write_number(unit_buf[base + 11]);
        w.write_number(unit_buf[base + 12]);
    }
    if has_unit_type {
        w.write_number(unit_buf[base + 14]);
    }
    if has_radius {
        w.write_number(unit_buf[base + 16]);
        w.write_number(unit_buf[base + 17]);
        w.write_number(unit_buf[base + 18]);
    }
    if has_bch {
        w.write_number(unit_buf[base + 20]);
    }
    if has_mass {
        w.write_number(unit_buf[base + 22]);
    }
    if has_surface_normal {
        w.write_number(unit_buf[base + 24]);
        w.write_number(unit_buf[base + 25]);
        w.write_number(unit_buf[base + 26]);
    }
    if has_orientation {
        w.write_number(unit_buf[base + 28]);
        w.write_number(unit_buf[base + 29]);
        w.write_number(unit_buf[base + 30]);
        w.write_number(unit_buf[base + 31]);
    }
    if has_angular_velocity {
        w.write_number(unit_buf[base + 33]);
        w.write_number(unit_buf[base + 34]);
        w.write_number(unit_buf[base + 35]);
    }
    if has_fire_state {
        w.write_number(unit_buf[base + 52]);
    }
    if cloak_present {
        w.write_number(unit_buf[base + 62]);
    }
    if build_target_present && !build_target_null {
        w.write_number(unit_buf[base + 40]);
    }
    if has_actions {
        let action_count = unit_buf[base + 42] as usize;
        let action_offset = unit_buf[base + 50] as i64;
        w.write_array_header(action_count);
        if action_offset >= 0 {
            let off = action_offset as usize;
            for a in 0..action_count {
                v6_write_detail_action(w, action_buf, off + a);
            }
        }
    }
    if has_turrets {
        let turret_count = unit_buf[base + 44] as usize;
        let turret_offset = unit_buf[base + 49] as i64;
        w.write_array_header(turret_count);
        if turret_offset >= 0 {
            let off = turret_offset as usize;
            for t in 0..turret_count {
                v6_write_detail_turret(w, turret_buf, off + t);
            }
        }
    }
    if has_build {
        w.write_number(unit_buf[base + 47]);
        w.write_number(unit_buf[base + 48]);
    }
    if builder_priority_present {
        w.write_number(if builder_priority_low { 1.0 } else { 0.0 });
    }
    if carrier_spawn_present {
        w.write_number(unit_buf[base + 65]);
    }
    if has_work_station {
        if !carrier_spawn_present {
            w.write_number(1.0);
        }
        w.write_number(1.0); // extension mask: bit 0 = QueryWork pose
        w.write_number(unit_buf[base + 69]);
        w.write_number(unit_buf[base + 70]);
        w.write_number(unit_buf[base + 71]);
        w.write_number(unit_buf[base + 72]);
        w.write_number(unit_buf[base + 73]);
        w.write_number(unit_buf[base + 74]);
        w.write_number(unit_buf[base + 75]);
        w.write_number(unit_buf[base + 76]);
    }
}

pub(crate) fn v6_write_detail_building(
    w: &mut MessagePackWriter,
    building_buf: &[f64],
    base: usize,
    turret_buf: &[f64],
    queue_buf: &[u32],
    waypoint_buf: &[f64],
    waypoint_string_base: u32,
) {
    let is_full = building_buf[base + 6] == 0.0;
    let cf = building_buf[base + 7] as u32;
    let has_type = building_buf[base + 8] != 0.0;
    let has_dim = building_buf[base + 10] != 0.0;
    let hp_present = v6_present(is_full, cf, ENTITY_CHANGED_HP);
    let build_present = v6_present(is_full, cf, ENTITY_CHANGED_BUILDING);
    let build_complete = building_buf[base + 15] != 0.0;
    let build_interrupted = building_buf[base + 34] != 0.0;
    let has_metal_extraction = building_buf[base + 18] != 0.0;
    let has_solar = building_buf[base + 20] != 0.0;
    let solar_open = building_buf[base + 21] != 0.0;
    let has_turrets = building_buf[base + 22] != 0.0;
    let has_factory = building_buf[base + 24] != 0.0;
    let factory_producing = building_buf[base + 27] != 0.0;

    let mut flags = 0u32;
    if has_type {
        flags |= V6_BUILDING_FLAG_BLUEPRINT_CODE;
    }
    if has_dim {
        flags |= V6_BUILDING_FLAG_DIM;
    }
    if hp_present {
        flags |= V6_BUILDING_FLAG_HP;
    }
    if build_present {
        flags |= V6_BUILDING_FLAG_BUILD;
        if build_complete {
            flags |= V6_BUILDING_FLAG_BUILD_COMPLETE;
        }
        if build_interrupted {
            flags |= V6_BUILDING_FLAG_BUILD_INTERRUPTED;
        }
    }
    if has_metal_extraction {
        flags |= V6_BUILDING_FLAG_METAL_EXTRACTION_RATE;
    }
    if has_solar {
        flags |= V6_BUILDING_FLAG_SOLAR;
        if solar_open {
            flags |= V6_BUILDING_FLAG_SOLAR_OPEN;
        }
    }
    if has_turrets {
        flags |= V6_BUILDING_FLAG_TURRETS;
    }
    if has_factory {
        flags |= V6_BUILDING_FLAG_FACTORY;
        if factory_producing {
            flags |= V6_BUILDING_FLAG_FACTORY_PRODUCING;
        }
    }

    let mut len = 1usize;
    if has_type {
        len += 1;
    }
    if has_dim {
        len += 2;
    }
    if hp_present {
        len += 2;
    }
    if build_present {
        len += 2;
    }
    if has_metal_extraction {
        len += 1;
    }
    if has_turrets {
        len += 1;
    }
    if has_factory {
        len += 1;
    }

    w.write_array_header(len);
    w.write_number(flags as f64);
    if has_type {
        w.write_number(building_buf[base + 9]);
    }
    if has_dim {
        w.write_number(building_buf[base + 11]);
        w.write_number(building_buf[base + 12]);
    }
    if hp_present {
        w.write_number(building_buf[base + 13]);
        w.write_number(building_buf[base + 14]);
    }
    if build_present {
        w.write_number(building_buf[base + 16]);
        w.write_number(building_buf[base + 17]);
    }
    if has_metal_extraction {
        w.write_number(building_buf[base + 19]);
    }
    if has_turrets {
        let turret_count = building_buf[base + 23] as usize;
        let turret_offset = building_buf[base + 31] as i64;
        w.write_array_header(turret_count);
        if turret_offset >= 0 {
            let off = turret_offset as usize;
            for t in 0..turret_count {
                v6_write_detail_turret(w, turret_buf, off + t);
            }
        }
    }
    if has_factory {
        v6_write_detail_factory(
            w,
            building_buf,
            base,
            queue_buf,
            waypoint_buf,
            waypoint_string_base,
        );
    }
}

pub(crate) fn v6_write_detail_row(
    w: &mut MessagePackWriter,
    input: &SnapshotEncodeV6InputScratch,
    kind: u32,
    row: usize,
    turret_buf: &[f64],
    action_buf: &[f64],
    queue_buf: &[u32],
    waypoint_buf: &[f64],
    waypoint_string_base: u32,
) {
    if kind == V6_KIND_UNIT {
        let base = row * V6_UNIT_STRIDE;
        let is_full = input.unit[base + 6] == 0.0;
        let cf = input.unit[base + 7] as u32;
        let pos_present = v6_present(is_full, cf, ENTITY_CHANGED_POS);
        let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
        let mut flags = V6_ENTITY_FLAG_HAS_UNIT;
        if pos_present {
            flags |= V6_ENTITY_FLAG_HAS_POS;
        }
        if rot_present {
            flags |= V6_ENTITY_FLAG_HAS_ROTATION;
        }
        if !is_full {
            flags |= V6_ENTITY_FLAG_HAS_CHANGED_FIELDS;
        }
        let mut len = 3usize;
        if pos_present {
            len += 3;
        }
        if rot_present {
            len += 1;
        }
        if !is_full {
            len += 1;
        }
        len += 1; // unit sub-array
        w.write_array_header(len);
        w.write_number(flags as f64);
        w.write_number(input.unit[base + 0]); // id
        w.write_number(input.unit[base + 5]); // playerId
        if pos_present {
            w.write_number(input.unit[base + 1]);
            w.write_number(input.unit[base + 2]);
            w.write_number(input.unit[base + 3]);
        }
        if rot_present {
            w.write_number(input.unit[base + 4]);
        }
        if !is_full {
            w.write_number(cf as f64);
        }
        v6_write_detail_unit(w, &input.unit, base, turret_buf, action_buf);
        return;
    }
    if kind == V6_KIND_BUILDING {
        let base = row * V6_BUILDING_STRIDE;
        let is_full = input.building[base + 6] == 0.0;
        let cf = input.building[base + 7] as u32;
        let pos_present = v6_present(is_full, cf, ENTITY_CHANGED_POS);
        let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
        let mut flags = V6_ENTITY_FLAG_TYPE_BUILDING | V6_ENTITY_FLAG_HAS_BUILDING;
        if pos_present {
            flags |= V6_ENTITY_FLAG_HAS_POS;
        }
        if rot_present {
            flags |= V6_ENTITY_FLAG_HAS_ROTATION;
        }
        if !is_full {
            flags |= V6_ENTITY_FLAG_HAS_CHANGED_FIELDS;
        }
        let mut len = 3usize;
        if pos_present {
            len += 3;
        }
        if rot_present {
            len += 1;
        }
        if !is_full {
            len += 1;
        }
        len += 1; // building sub-array
        w.write_array_header(len);
        w.write_number(flags as f64);
        w.write_number(input.building[base + 0]); // id
        w.write_number(input.building[base + 5]); // playerId
        if pos_present {
            w.write_number(input.building[base + 1]);
            w.write_number(input.building[base + 2]);
            w.write_number(input.building[base + 3]);
        }
        if rot_present {
            w.write_number(input.building[base + 4]);
        }
        if !is_full {
            w.write_number(cf as f64);
        }
        v6_write_detail_building(
            w,
            &input.building,
            base,
            turret_buf,
            queue_buf,
            waypoint_buf,
            waypoint_string_base,
        );
        return;
    }
    // V6_KIND_BASIC (no unit/building sub-array)
    let base = row * V6_BASIC_STRIDE;
    let is_unit = input.basic[base + 1] == V6_WIRE_TYPE_UNIT;
    let is_full = input.basic[base + 7] == 0.0;
    let cf = input.basic[base + 8] as u32;
    let pos_present = v6_present(is_full, cf, ENTITY_CHANGED_POS);
    let rot_present = v6_present(is_full, cf, ENTITY_CHANGED_ROT);
    let mut flags = 0u32;
    if pos_present {
        flags |= V6_ENTITY_FLAG_HAS_POS;
    }
    if rot_present {
        flags |= V6_ENTITY_FLAG_HAS_ROTATION;
    }
    if !is_full {
        flags |= V6_ENTITY_FLAG_HAS_CHANGED_FIELDS;
    }
    if !is_unit {
        flags |= V6_ENTITY_FLAG_TYPE_BUILDING;
    }
    let mut len = 3usize;
    if pos_present {
        len += 3;
    }
    if rot_present {
        len += 1;
    }
    if !is_full {
        len += 1;
    }
    w.write_array_header(len);
    w.write_number(flags as f64);
    w.write_number(input.basic[base + 0]); // id
    w.write_number(input.basic[base + 6]); // playerId
    if pos_present {
        w.write_number(input.basic[base + 2]);
        w.write_number(input.basic[base + 3]);
        w.write_number(input.basic[base + 4]);
    }
    if rot_present {
        w.write_number(input.basic[base + 5]);
    }
    if !is_full {
        w.write_number(cf as f64);
    }
}

/// Emit the `entities` key + the compact V6 `{v,m,t,b,e}` value. The caller must
/// have opened the envelope via snapshot_encode_envelope_begin_packed_entities
/// and bulk-filled the V6 input scratch + the shared
/// turret/action/waypoint/factory-queue/string scratches. `entity_count` is the
/// number of kinds/row_indices entries; `waypoint_string_base` is the slot
/// offset where waypoint-type strings begin in the (action ++ waypoint) ordered
/// string scratch. Returns the writer length, or u32::MAX if a RAW
/// (un-encodable) entity kind is present, in which case the caller emits raw
/// entity DTOs.
#[wasm_bindgen]
pub fn snapshot_encode_emit_entities_v6(entity_count: u32, waypoint_string_base: u32) -> u32 {
    let entity_count = entity_count as usize;
    let input = snapshot_encode_v6_input_scratch();
    let work = snapshot_encode_v6_work_scratch();
    work.reset();
    work.m_out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    work.t_out.reset(PACKED_BINARY_ROW_COUNT_BYTES);
    work.b_out.reset(PACKED_BINARY_ROW_COUNT_BYTES);

    // Pass 1: classify + accumulate movement/turret slabs, collect detail rows.
    // RAW rows (private-detail DTOs pre-encoded by JS) ride the `e` array
    // alongside typed detail rows instead of forcing the whole entities
    // section off the packed path.
    for i in 0..entity_count {
        let kind = input.kinds[i];
        if kind == V6_KIND_RAW {
            work.detail.push(i as u32);
            continue;
        }
        let row = input.row_indices[i] as usize;

        if v6_is_movement_only(input, kind, row) {
            let flags = v6_movement_flags(input, kind, row);
            let player_id = if kind == V6_KIND_BASIC {
                input.basic[row * V6_BASIC_STRIDE + 6] as u32
            } else {
                input.unit[row * V6_UNIT_STRIDE + 5] as u32
            };
            let id = if kind == V6_KIND_BASIC {
                input.basic[row * V6_BASIC_STRIDE] as i64
            } else {
                input.unit[row * V6_UNIT_STRIDE] as i64
            };
            let gi = work.movement_group_index(flags, player_id);
            let delta = id - work.movement_groups[gi].last_id;
            work.movement_groups[gi].writer.write_var_int(delta);
            work.movement_groups[gi].last_id = id;
            // Borrow the group writer + input together (disjoint statics).
            {
                let group_writer = &mut work.movement_groups[gi].writer;
                v6_write_movement_payload(group_writer, input, kind, row, flags);
            }
            work.movement_groups[gi].count += 1;
            work.movement_row_count += 1;
            continue;
        }

        if v6_is_split_turret(input, kind, row) {
            // KIND_UNIT only.
            if v6_has_movement_fields(input, row) {
                let flags = v6_movement_flags(input, kind, row);
                let player_id = input.unit[row * V6_UNIT_STRIDE + 5] as u32;
                let id = input.unit[row * V6_UNIT_STRIDE] as i64;
                let gi = work.movement_group_index(flags, player_id);
                let delta = id - work.movement_groups[gi].last_id;
                work.movement_groups[gi].writer.write_var_int(delta);
                work.movement_groups[gi].last_id = id;
                {
                    let group_writer = &mut work.movement_groups[gi].writer;
                    v6_write_movement_payload(group_writer, input, kind, row, flags);
                }
                work.movement_groups[gi].count += 1;
                work.movement_row_count += 1;
            }
            let base = row * V6_UNIT_STRIDE;
            let player_id = input.unit[base + 5] as u32;
            let turret_count = input.unit[base + 44] as u32;
            let turret_offset = input.unit[base + 49] as usize;
            let id = input.unit[base] as i64;
            let gi = work.turret_group_index(player_id, turret_count);
            let delta = id - work.turret_groups[gi].last_id;
            work.turret_groups[gi].writer.write_var_int(delta);
            work.turret_groups[gi].last_id = id;
            {
                let turret_buf = &snapshot_encode_turret_scratch().buf;
                let group_writer = &mut work.turret_groups[gi].writer;
                v6_write_turret_payload(
                    group_writer,
                    turret_buf,
                    turret_offset,
                    turret_count as usize,
                );
            }
            work.turret_groups[gi].count += 1;
            work.turret_row_count += 1;
            continue;
        }

        if v6_is_building_delta(input, kind, row) {
            let flags = v6_building_delta_flags(input, kind, row);
            let player_id = if kind == V6_KIND_BASIC {
                input.basic[row * V6_BASIC_STRIDE + 6] as u32
            } else {
                input.building[row * V6_BUILDING_STRIDE + 5] as u32
            };
            let id = if kind == V6_KIND_BASIC {
                input.basic[row * V6_BASIC_STRIDE] as i64
            } else {
                input.building[row * V6_BUILDING_STRIDE] as i64
            };
            let gi = work.building_group_index(flags, player_id);
            let delta = id - work.building_groups[gi].last_id;
            work.building_groups[gi].writer.write_var_int(delta);
            work.building_groups[gi].last_id = id;
            {
                let group_writer = &mut work.building_groups[gi].writer;
                v6_write_building_delta_payload(group_writer, input, kind, row, flags);
            }
            work.building_groups[gi].count += 1;
            work.building_row_count += 1;
            continue;
        }

        work.detail.push(i as u32);
    }

    // Finish the movement slab.
    if work.movement_row_count > 0 {
        let group_count = work.movement_group_count;
        work.m_out.write_var_uint(group_count as u64);
        for i in 0..group_count {
            let flags = work.movement_groups[i].flags;
            let player_id = work.movement_groups[i].player_id;
            let count = work.movement_groups[i].count;
            work.m_out.write_var_uint(flags as u64);
            work.m_out.write_var_uint(player_id as u64);
            work.m_out.write_var_uint(count as u64);
            let bytes_len = work.movement_groups[i].writer.as_slice().len();
            // Copy group bytes into m_out (separate borrows of the same struct).
            for b in 0..bytes_len {
                let byte = work.movement_groups[i].writer.as_slice()[b];
                work.m_out.buf.push(byte);
            }
        }
        let row_count = work.movement_row_count;
        work.m_out.set_u32_le(0, row_count);
    }

    // Finish the turret slab.
    if work.turret_row_count > 0 {
        let group_count = work.turret_group_count;
        work.t_out.write_var_uint(group_count as u64);
        for i in 0..group_count {
            let player_id = work.turret_groups[i].player_id;
            let turret_count = work.turret_groups[i].turret_count;
            let count = work.turret_groups[i].count;
            work.t_out.write_var_uint(player_id as u64);
            work.t_out.write_var_uint(turret_count as u64);
            work.t_out.write_var_uint(count as u64);
            let bytes_len = work.turret_groups[i].writer.as_slice().len();
            for b in 0..bytes_len {
                let byte = work.turret_groups[i].writer.as_slice()[b];
                work.t_out.buf.push(byte);
            }
        }
        let row_count = work.turret_row_count;
        work.t_out.set_u32_le(0, row_count);
    }

    // Finish the building delta slab.
    if work.building_row_count > 0 {
        let group_count = work.building_group_count;
        work.b_out.write_var_uint(group_count as u64);
        for i in 0..group_count {
            let flags = work.building_groups[i].flags;
            let player_id = work.building_groups[i].player_id;
            let count = work.building_groups[i].count;
            work.b_out.write_var_uint(flags as u64);
            work.b_out.write_var_uint(player_id as u64);
            work.b_out.write_var_uint(count as u64);
            let bytes_len = work.building_groups[i].writer.as_slice().len();
            for b in 0..bytes_len {
                let byte = work.building_groups[i].writer.as_slice()[b];
                work.b_out.buf.push(byte);
            }
        }
        let row_count = work.building_row_count;
        work.b_out.set_u32_le(0, row_count);
    }

    let has_m = work.movement_row_count > 0;
    let has_t = work.turret_row_count > 0;
    let has_b = work.building_row_count > 0;
    let detail_count = work.detail.len();
    // `e` is present if there are detail rows, or if there is no other section
    // (so an empty entities array still emits `e: []`).
    let has_e = detail_count > 0 || (!has_m && !has_t && !has_b);

    let mut map_size = 1usize; // v
    if has_m {
        map_size += 1;
    }
    if has_t {
        map_size += 1;
    }
    if has_b {
        map_size += 1;
    }
    if has_e {
        map_size += 1;
    }

    let turret_buf = &snapshot_encode_turret_scratch().buf;
    let action_buf = &snapshot_encode_action_scratch().buf;
    let queue_buf = &snapshot_encode_factory_queue_scratch().buf;
    let waypoint_buf = &snapshot_encode_waypoint_scratch().buf;
    let w = messagepack_writer();
    w.write_str("entities");
    w.write_map_header(map_size);
    w.write_str("v");
    w.write_uint(V6_PACKED_ENTITIES_VERSION);
    if has_m {
        w.write_str("m");
        w.write_bin(work.m_out.as_slice());
    }
    if has_t {
        w.write_str("t");
        w.write_bin(work.t_out.as_slice());
    }
    if has_b {
        w.write_str("b");
        w.write_bin(work.b_out.as_slice());
    }
    if has_e {
        w.write_str("e");
        w.write_array_header(detail_count);
        // RAW spans are consumed in entity-index order, which matches the
        // order JS marshalled them and the order pass 1 pushed detail rows.
        let mut raw_ordinal = 0usize;
        for d in 0..detail_count {
            let i = work.detail[d] as usize;
            let kind = input.kinds[i];
            if kind == V6_KIND_RAW {
                let span_base = raw_ordinal * 2;
                let offset = input.raw_spans[span_base] as usize;
                let len = input.raw_spans[span_base + 1] as usize;
                w.append_raw_value(&input.raw_bytes[offset..offset + len]);
                raw_ordinal += 1;
                continue;
            }
            let row = input.row_indices[i] as usize;
            v6_write_detail_row(
                w,
                input,
                kind,
                row,
                turret_buf,
                action_buf,
                queue_buf,
                waypoint_buf,
                waypoint_string_base,
            );
        }
    }
    w.len() as u32
}

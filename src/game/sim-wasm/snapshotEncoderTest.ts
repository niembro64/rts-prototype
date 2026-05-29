// Phase 10 D.3j — byte-equality test runner for the Rust entity
// encoder. Runs once at initSimWasm completion in dev builds.
// Each fixture: build the JS DTO, encode via @msgpack/msgpack with
// `ignoreUndefined: true`, call the matching Rust kernel, read the
// scratch bytes, assert equality. console.error on any mismatch.

import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  snapshot_encode_entity_basic,
  snapshot_encode_entity_unit,
  snapshot_encode_entity_building,
  snapshot_encode_envelope_begin,
  snapshot_encode_envelope_continue,
  snapshot_encode_envelope_emit_economy,
  snapshot_encode_envelope_emit_minimap,
  snapshot_encode_envelope_emit_packed_minimap,
  snapshot_encode_envelope_emit_packed_projectiles,
  snapshot_encode_envelope_emit_projectiles,
  snapshot_encode_envelope_emit_spray_targets,
  snapshot_encode_spray_scratch_ptr,
  snapshot_encode_spray_scratch_ensure,
  snapshot_encode_economy_scratch_ptr,
  snapshot_encode_economy_scratch_ensure,
  snapshot_encode_envelope_emit_audio_events,
  snapshot_encode_audio_event_scratch_ptr,
  snapshot_encode_audio_event_scratch_ensure,
  snapshot_encode_death_context_scratch_ptr,
  snapshot_encode_death_context_scratch_ensure,
  snapshot_encode_turret_pose_scratch_ptr,
  snapshot_encode_turret_pose_scratch_ensure,
  snapshot_encode_impact_context_scratch_ptr,
  snapshot_encode_impact_context_scratch_ensure,
  snapshot_encode_envelope_emit_scan_pulses,
  snapshot_encode_scan_pulse_scratch_ptr,
  snapshot_encode_scan_pulse_scratch_ensure,
  snapshot_encode_envelope_emit_shroud,
  snapshot_encode_shroud_scratch_ptr,
  snapshot_encode_shroud_scratch_ensure,
  snapshot_encode_envelope_emit_packed_terrain,
  snapshot_encode_envelope_emit_terrain,
  snapshot_encode_envelope_emit_packed_buildability,
  snapshot_encode_envelope_emit_buildability,
  snapshot_encode_number_scratch_ptr,
  snapshot_encode_number_scratch_ensure,
  snapshot_encode_minimap_scratch_ptr,
  snapshot_encode_minimap_scratch_ensure,
  snapshot_encode_beam_update_scratch_ptr,
  snapshot_encode_beam_update_scratch_ensure,
  snapshot_encode_beam_point_scratch_ptr,
  snapshot_encode_beam_point_scratch_ensure,
  snapshot_encode_proj_despawn_scratch_ptr,
  snapshot_encode_proj_despawn_scratch_ensure,
  snapshot_encode_proj_spawn_scratch_ptr,
  snapshot_encode_proj_spawn_scratch_ensure,
  snapshot_encode_proj_vel_scratch_ptr,
  snapshot_encode_proj_vel_scratch_ensure,
  snapshot_encode_removed_ids_scratch_ptr,
  snapshot_encode_removed_ids_scratch_ensure,
  messagepack_writer_clear,
  snapshot_encode_turret_scratch_ptr,
  snapshot_encode_turret_scratch_ensure,
  snapshot_encode_action_scratch_ptr,
  snapshot_encode_action_scratch_ensure,
  snapshot_encode_string_scratch_bytes_ptr,
  snapshot_encode_string_scratch_table_ptr,
  snapshot_encode_string_scratch_ensure_bytes,
  snapshot_encode_string_scratch_ensure_table,
  snapshot_encode_factory_queue_scratch_ptr,
  snapshot_encode_factory_queue_scratch_ensure,
  snapshot_encode_waypoint_scratch_ptr,
  snapshot_encode_waypoint_scratch_ensure,
  messagepack_writer_ptr,
  messagepack_writer_len,
} from './pkg/rts_sim_wasm';

const WAYPOINT_SCRATCH_STRIDE = 5;
// Acceleration is no longer shipped on the wire; the turret scratch
// shrank from 12 → 10 f64 per turret (drop angular.acc and
// angular.pitchAcc) — matches SNAPSHOT_ENCODE_TURRET_STRIDE in lib.rs.
import { SNAPSHOT_ENTITY_TYPE_UNIT, SNAPSHOT_ENTITY_TYPE_BUILDING } from './init';
import {
  ENTITY_CHANGED_BUILDING,
  ENTITY_CHANGED_HP,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
} from '@/types/network';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { packMinimapEntitiesForWire } from '../network/snapshotMinimapWirePack';
import { packProjectilesForWire } from '../network/snapshotProjectileWirePack';
import {
  packBuildabilityForWire,
  packTerrainForWire,
} from '../network/snapshotStaticWirePack';

const TURRET_SCRATCH_STRIDE = 10;
const ACTION_SCRATCH_STRIDE = 16;

const _utf8 = new TextEncoder();

/** Build the string scratch from a list of strings. Returns a
 *  Map from string to slot index that callers use when filling
 *  scratch buffers. */
function packStringsIntoScratch(
  memory: WebAssembly.Memory,
  strings: readonly string[],
): Map<string, number> {
  const slotByString = new Map<string, number>();
  if (strings.length === 0) return slotByString;
  const utf8Bytes: Uint8Array[] = [];
  let totalBytes = 0;
  for (const s of strings) {
    if (slotByString.has(s)) continue;
    const bytes = _utf8.encode(s);
    slotByString.set(s, utf8Bytes.length);
    utf8Bytes.push(bytes);
    totalBytes += bytes.length;
  }
  snapshot_encode_string_scratch_ensure_bytes(Math.max(totalBytes, 1));
  snapshot_encode_string_scratch_ensure_table(utf8Bytes.length);
  const bytesPtr = snapshot_encode_string_scratch_bytes_ptr();
  const tablePtr = snapshot_encode_string_scratch_table_ptr();
  const bytesView = new Uint8Array(memory.buffer, bytesPtr, totalBytes);
  const tableView = new Uint32Array(memory.buffer, tablePtr, utf8Bytes.length * 2);
  let offset = 0;
  for (let i = 0; i < utf8Bytes.length; i++) {
    const bytes = utf8Bytes[i];
    bytesView.set(bytes, offset);
    tableView[i * 2] = offset;
    tableView[i * 2 + 1] = bytes.length;
    offset += bytes.length;
  }
  return slotByString;
}

type TurretFixture = {
  turret: {
    turretBlueprintCode: number;
    angular: {
      rot: number; vel: number;
      pitch: number; pitchVel: number;
    };
  };
  targetId?: number;
  state: number;
  currentForceFieldRange?: number;
};

type ActionFixture = {
  type: number;
  pos?: { x: number; y: number };
  posZ?: number;
  pathExp?: true;
  targetId?: number;
  buildingBlueprintId?: string;
  grid?: { x: number; y: number };
  buildingId?: number;
};

const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;

type BasicEntityFixture = {
  id: number;
  type: 'unit' | 'building';
  pos: { x: number; y: number; z: number };
  rotation: number;
  playerId: number;
  changedFields?: number;
};

function fixtureHasField(f: BasicEntityFixture, bit: number): boolean {
  return f.changedFields === undefined || (f.changedFields & bit) !== 0;
}

function sparseBasicFixture<T extends BasicEntityFixture>(f: T): T {
  if (f.changedFields === undefined) return f;
  return {
    ...f,
    pos: fixtureHasField(f, ENTITY_CHANGED_POS) ? f.pos : undefined,
    rotation: fixtureHasField(f, ENTITY_CHANGED_ROT) ? f.rotation : undefined,
  } as T;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
    if (i < bytes.length - 1) out += ' ';
  }
  return out;
}

function runEntityBasicCases(memory: WebAssembly.Memory): { passed: number; failed: number } {
  const fixtures: BasicEntityFixture[] = [
    // Full snapshot — no changedFields key
    { id: 1, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1 },
    { id: 42, type: 'unit', pos: { x: 10050, y: -5030, z: 100070 }, rotation: 3141, playerId: 2 },
    { id: 9999, type: 'building', pos: { x: 100, y: 200, z: 300 }, rotation: -1570, playerId: 3 },
    // Delta — changedFields present
    { id: 7, type: 'unit', pos: { x: 1, y: 2, z: 3 }, rotation: 100, playerId: 1, changedFields: 0 },
    { id: 1234567, type: 'unit', pos: { x: 1, y: 2, z: 3 }, rotation: 100, playerId: 1, changedFields: 5 },
    { id: 555, type: 'building', pos: { x: -1, y: -2, z: -3 }, rotation: -100, playerId: 7, changedFields: 0xFFFF },
    // Larger int magnitudes to exercise multiple int-encoding branches
    { id: 0xFFFFFF, type: 'unit', pos: { x: 32768, y: -32769, z: 65535 }, rotation: 0, playerId: 0, changedFields: 0x80000000 },
  ];

  let passed = 0;
  let failed = 0;
  for (const f of fixtures) {
    const wireFixture = sparseBasicFixture(f);
    const jsBytes = msgpackEncode(wireFixture, SNAPSHOT_ENCODE_OPTIONS);
    const typeTag = f.type === 'unit' ? SNAPSHOT_ENTITY_TYPE_UNIT : SNAPSHOT_ENTITY_TYPE_BUILDING;
    const hasChanged = f.changedFields !== undefined ? 1 : 0;
    const changed = f.changedFields ?? 0;
    messagepack_writer_clear();
    snapshot_encode_entity_basic(
      f.id, typeTag,
      f.pos.x, f.pos.y, f.pos.z,
      f.rotation, f.playerId,
      hasChanged, changed,
    );
    const ptr = messagepack_writer_ptr();
    const len = messagepack_writer_len();
    const rustBytes = new Uint8Array(memory.buffer, ptr, len).slice();
    if (bytesEqual(jsBytes, rustBytes)) {
      passed++;
    } else {
      failed++;
      console.error(
        '[snapshot encoder] basic envelope byte mismatch',
        {
          fixture: f,
          jsLen: jsBytes.length,
          rustLen: rustBytes.length,
          jsHex: hex(jsBytes),
          rustHex: hex(rustBytes),
        },
      );
    }
  }
  return { passed, failed };
}

type UnitFixture = BasicEntityFixture & {
  unit: {
    hp: { curr: number; max: number };
    velocity: { x: number; y: number; z: number };
    unitBlueprintCode?: number;
    radius?: { body: number; shot: number; push: number };
    bodyCenterHeight?: number;
    mass?: number;
    surfaceNormal?: { nx: number; ny: number; nz: number };
    orientation?: { x: number; y: number; z: number; w: number };
    angularVelocity3?: { x: number; y: number; z: number };
    fireEnabled?: false;
    isCommander?: true;
    buildTargetId?: number | null;
    actions?: ActionFixture[];
    turrets?: TurretFixture[];
    build?: {
      complete: boolean;
      paid: { energy: number; metal: number };
    };
  };
};

function sparseUnitFixture(f: UnitFixture): UnitFixture {
  if (f.changedFields === undefined) return f;
  return {
    ...sparseBasicFixture(f),
    unit: {
      ...f.unit,
      hp: fixtureHasField(f, ENTITY_CHANGED_HP) ? f.unit.hp : undefined,
      velocity: fixtureHasField(f, ENTITY_CHANGED_VEL) ? f.unit.velocity : undefined,
    },
  } as UnitFixture;
}

function packActionsIntoScratch(
  memory: WebAssembly.Memory,
  actions: ActionFixture[],
  stringSlots: Map<string, number>,
): void {
  snapshot_encode_action_scratch_ensure(actions.length);
  const ptr = snapshot_encode_action_scratch_ptr();
  const view = new Float64Array(
    memory.buffer, ptr, actions.length * ACTION_SCRATCH_STRIDE,
  );
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const base = i * ACTION_SCRATCH_STRIDE;
    view[base + 0] = a.type;
    view[base + 1] = a.pos !== undefined ? 1 : 0;
    view[base + 2] = a.pos?.x ?? 0;
    view[base + 3] = a.pos?.y ?? 0;
    view[base + 4] = a.posZ !== undefined ? 1 : 0;
    view[base + 5] = a.posZ ?? 0;
    view[base + 6] = a.pathExp === true ? 1 : 0;
    view[base + 7] = a.targetId !== undefined ? 1 : 0;
    view[base + 8] = a.targetId ?? 0;
    view[base + 9] = a.buildingBlueprintId !== undefined ? 1 : 0;
    view[base + 10] = a.buildingBlueprintId !== undefined ? (stringSlots.get(a.buildingBlueprintId) ?? 0) : 0;
    view[base + 11] = a.grid !== undefined ? 1 : 0;
    view[base + 12] = a.grid?.x ?? 0;
    view[base + 13] = a.grid?.y ?? 0;
    view[base + 14] = a.buildingId !== undefined ? 1 : 0;
    view[base + 15] = a.buildingId ?? 0;
  }
}

function packTurretsIntoScratch(memory: WebAssembly.Memory, turrets: TurretFixture[]): void {
  snapshot_encode_turret_scratch_ensure(turrets.length);
  const ptr = snapshot_encode_turret_scratch_ptr();
  const view = new Float64Array(
    memory.buffer, ptr, turrets.length * TURRET_SCRATCH_STRIDE,
  );
  for (let i = 0; i < turrets.length; i++) {
    const t = turrets[i];
    const base = i * TURRET_SCRATCH_STRIDE;
    view[base + 0] = t.turret.angular.rot;
    view[base + 1] = t.turret.angular.vel;
    view[base + 2] = t.turret.angular.pitch;
    view[base + 3] = t.turret.angular.pitchVel;
    view[base + 4] = t.turret.turretBlueprintCode;
    view[base + 5] = t.state;
    view[base + 6] = t.targetId !== undefined ? 1 : 0;
    view[base + 7] = t.targetId ?? 0;
    view[base + 8] = t.currentForceFieldRange !== undefined ? 1 : 0;
    view[base + 9] = t.currentForceFieldRange ?? 0;
  }
}

function runEntityUnitCases(memory: WebAssembly.Memory): { passed: number; failed: number } {
  const fixtures: UnitFixture[] = [
    // hp + velocity only (no surfaceNormal). Most common idle case.
    {
      id: 1, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: { hp: { curr: 100, max: 100 }, velocity: { x: 0, y: 0, z: 0 } },
    },
    // Damaged unit, signed quantized velocity, no normal
    {
      id: 42, type: 'unit', pos: { x: 1000, y: -2000, z: 50 }, rotation: 314, playerId: 2,
      unit: { hp: { curr: 73, max: 250 }, velocity: { x: 15, y: -8, z: 0 } },
    },
    // Fractional HP — exercises f64 encoding branch
    {
      id: 99, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: { hp: { curr: 12.5, max: 100 }, velocity: { x: 0, y: 0, z: 0 } },
    },
    // Full keyframe static unit fields. Runtime DTO pools start with
    // hp + velocity, then add static fields in this order on full records.
    {
      id: 100, type: 'unit', pos: { x: 10, y: 20, z: 30 }, rotation: 1571, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        unitBlueprintCode: 4,
        radius: { body: 12, shot: 15, push: 18 },
        bodyCenterHeight: 21,
        mass: 35,
      },
    },
    // Full commander keyframe static fields with the isCommander flag.
    {
      id: 101, type: 'unit', pos: { x: 40, y: 50, z: 60 }, rotation: 0, playerId: 2,
      unit: {
        hp: { curr: 5000, max: 5000 },
        velocity: { x: 0, y: 0, z: 0 },
        unitBlueprintCode: 0,
        radius: { body: 20, shot: 20, push: 22 },
        bodyCenterHeight: 24,
        mass: 250,
        isCommander: true,
      },
    },
    // Delta path with changedFields, no normal
    {
      id: 7, type: 'unit', pos: { x: 1, y: 2, z: 3 }, rotation: 100, playerId: 1, changedFields: 4,
      unit: { hp: { curr: 200, max: 200 }, velocity: { x: 500, y: -500, z: 100 } },
    },
    // High id + large hp values
    {
      id: 0xFFFFFF, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 0,
      unit: { hp: { curr: 1234567, max: 9999999 }, velocity: { x: 0, y: 0, z: 0 } },
    },
    // Flat-ground normal (z = qNormal(1.0) = 1000)
    {
      id: 1, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        surfaceNormal: { nx: 0, ny: 0, nz: 1000 },
      },
    },
    // Tilted slope normal (non-axis-aligned)
    {
      id: 256, type: 'unit', pos: { x: 5000, y: 5000, z: 100 }, rotation: -1571, playerId: 3,
      unit: {
        hp: { curr: 88, max: 120 },
        velocity: { x: 10, y: -5, z: 2 },
        surfaceNormal: { nx: 174, ny: -342, nz: 924 },  // ~80° from vertical
      },
    },
    // Inverted normal (e.g. a unit on a steep overhang) + delta path
    {
      id: 9999, type: 'unit', pos: { x: -100, y: -200, z: 500 }, rotation: 100, playerId: 2, changedFields: 0x108,
      unit: {
        hp: { curr: 50, max: 50 },
        velocity: { x: 0, y: 0, z: -120 },
        surfaceNormal: { nx: -707, ny: 0, nz: 707 },
      },
    },
    // Cruising up a slope (acceleration no longer on the wire — the
    // client extrapolates from velocity only, see design philosophy).
    {
      id: 33, type: 'unit', pos: { x: 5000, y: 5000, z: 200 }, rotation: 1571, playerId: 2,
      unit: {
        hp: { curr: 88, max: 120 },
        velocity: { x: 100, y: 50, z: 5 },
        surfaceNormal: { nx: 100, ny: 100, nz: 985 },
      },
    },
    // Delta path with negative velocity components.
    {
      id: 511, type: 'unit', pos: { x: 1, y: 2, z: 3 }, rotation: -100, playerId: 3, changedFields: 0x404,
      unit: {
        hp: { curr: 200, max: 200 },
        velocity: { x: -200, y: 0, z: 0 },
      },
    },
    // surfaceNormal delta on slope (acceleration and visual suspension
    // are no longer shipped).
    {
      id: 330, type: 'unit', pos: { x: 5000, y: 5000, z: 200 }, rotation: 1571, playerId: 2, changedFields: 0x204,
      unit: {
        hp: { curr: 75, max: 120 },
        velocity: { x: 50, y: 25, z: 3 },
        surfaceNormal: { nx: 100, ny: 100, nz: 985 },
      },
    },
    // Everything together — unit on a slope (acceleration not shipped;
    // the per-channel EMA on the client smooths the approach to the
    // freshly arrived target).
    {
      id: 414, type: 'unit', pos: { x: 1000, y: 2000, z: 300 }, rotation: -1571, playerId: 3, changedFields: 0x80F,
      unit: {
        hp: { curr: 60, max: 100 },
        velocity: { x: 75, y: -25, z: 200 },
        surfaceNormal: { nx: 50, ny: -100, nz: 990 },
      },
    },
    // POS-client hover unit: orientation only, no angular fields
    {
      id: 510, type: 'unit', pos: { x: 0, y: 0, z: 500 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1000 },  // identity (×1000)
      },
    },
    // VEL-client hover unit: orientation + angularVelocity3, no acceleration
    {
      id: 511, type: 'unit', pos: { x: 100, y: 0, z: 500 }, rotation: 314, playerId: 2,
      unit: {
        hp: { curr: 90, max: 100 },
        velocity: { x: 150, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 707, w: 707 },  // 90° yaw
        angularVelocity3: { x: 0, y: 0, z: 50 },
      },
    },
    // Hover unit banking into a turn (angular acceleration no longer
    // shipped; client integrates rotation from angular velocity only).
    {
      id: 512, type: 'unit', pos: { x: 500, y: 500, z: 800 }, rotation: 1571, playerId: 3, changedFields: 0x4,
      unit: {
        hp: { curr: 75, max: 100 },
        velocity: { x: 200, y: 100, z: 10 },
        orientation: { x: -100, y: 0, z: 707, w: 700 },
        angularVelocity3: { x: 0, y: -30, z: 100 },
      },
    },
    // Negative quaternion components + negative angular velocity vector.
    {
      id: 513, type: 'unit', pos: { x: -100, y: -200, z: 600 }, rotation: -1571, playerId: 1,
      unit: {
        hp: { curr: 40, max: 100 },
        velocity: { x: -50, y: -100, z: -20 },
        orientation: { x: -174, y: -342, z: -924, w: 1 },
        angularVelocity3: { x: -25, y: -50, z: -75 },
      },
    },
    // fireEnabled (hold-fire mode)
    {
      id: 610, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        fireEnabled: false,
      },
    },
    // isCommander flag (commander shell)
    {
      id: 611, type: 'unit', pos: { x: 1000, y: 1000, z: 50 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 5000, max: 5000 },
        velocity: { x: 0, y: 0, z: 0 },
        isCommander: true,
      },
    },
    // buildTargetId — concrete number (builder actively constructing)
    {
      id: 612, type: 'unit', pos: { x: 200, y: 200, z: 0 }, rotation: 0, playerId: 2,
      unit: {
        hp: { curr: 80, max: 80 },
        velocity: { x: 0, y: 0, z: 0 },
        buildTargetId: 5432,
      },
    },
    // buildTargetId — null (target out of recipient's vision)
    {
      id: 613, type: 'unit', pos: { x: 300, y: 300, z: 0 }, rotation: 0, playerId: 2,
      unit: {
        hp: { curr: 80, max: 80 },
        velocity: { x: 0, y: 0, z: 0 },
        buildTargetId: null,
      },
    },
    // All three scalar optionals together (commander on hold-fire while building)
    {
      id: 614, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1, changedFields: 0x1008,
      unit: {
        hp: { curr: 4500, max: 5000 },
        velocity: { x: 0, y: 0, z: 0 },
        isCommander: true,
        fireEnabled: false,
        buildTargetId: 99999,
      },
    },
    // Single idle turret (no target, no force field, all-zero angular state)
    {
      id: 700, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        turrets: [
          {
            turret: {
              turretBlueprintCode: 5,
              angular: { rot: 0, vel: 0, pitch: 0, pitchVel: 0 },
            },
            state: 0,  // idle
          },
        ],
      },
    },
    // Engaged turret with target + non-trivial angular state
    {
      id: 701, type: 'unit', pos: { x: 100, y: 200, z: 0 }, rotation: 0, playerId: 2,
      unit: {
        hp: { curr: 75, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        turrets: [
          {
            turret: {
              turretBlueprintCode: 12,
              angular: { rot: 1.235, vel: 0.5, pitch: 0.3, pitchVel: 0.05 },
            },
            targetId: 887,
            state: 2,  // engaged
          },
        ],
      },
    },
    // Force-field turret (engaged with FF range and target)
    {
      id: 702, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 3,
      unit: {
        hp: { curr: 50, max: 50 },
        velocity: { x: 0, y: 0, z: 0 },
        turrets: [
          {
            turret: {
              turretBlueprintCode: 33,
              angular: { rot: 0, vel: 0, pitch: 1.571, pitchVel: 0 },
            },
            targetId: 1234,
            state: 1,  // tracking
            currentForceFieldRange: 250.5,
          },
        ],
      },
    },
    // Multi-turret unit (3 turrets, mixed states + targets)
    {
      id: 703, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1, changedFields: 0x20,
      unit: {
        hp: { curr: 200, max: 200 },
        velocity: { x: 0, y: 0, z: 0 },
        turrets: [
          {
            turret: { turretBlueprintCode: 1, angular: { rot: 0, vel: 0, pitch: 0, pitchVel: 0 } },
            state: 0,
          },
          {
            turret: { turretBlueprintCode: 2, angular: { rot: 1.5, vel: 0.1, pitch: 0.2, pitchVel: 0 } },
            targetId: 999,
            state: 2,
          },
          {
            turret: { turretBlueprintCode: 3, angular: { rot: -0.5, vel: 0, pitch: 0, pitchVel: 0 } },
            state: 1,
            currentForceFieldRange: 100,
          },
        ],
      },
    },
    // Max-cap turret unit (8 turrets — capacity stress)
    {
      id: 704, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2,
      unit: {
        hp: { curr: 1000, max: 1000 },
        velocity: { x: 0, y: 0, z: 0 },
        turrets: Array.from({ length: 8 }, (_, i): TurretFixture => ({
          turret: { turretBlueprintCode: i, angular: { rot: i * 0.1, vel: 0, pitch: 0, pitchVel: 0 } },
          state: i % 3,
        })),
      },
    },
    // Single move action (just type — minimal case)
    {
      id: 800, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 1 },
        ],
      },
    },
    // Move action with pos + posZ
    {
      id: 801, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 1, pos: { x: 5000, y: 3000 }, posZ: 50 },
        ],
      },
    },
    // Attack-target action (type + targetId)
    {
      id: 802, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 5, targetId: 999 },
        ],
      },
    },
    // Path-expansion intermediate (pos + pathExp)
    {
      id: 803, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 1, pos: { x: 1000, y: 2000 }, posZ: 25, pathExp: true },
        ],
      },
    },
    // Build action with grid + buildingId (no buildingBlueprintId — string not supported yet)
    {
      id: 804, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 7, grid: { x: 50, y: 75 }, buildingId: 12345 },
        ],
      },
    },
    // Multi-action queue (path-expansion sequence)
    {
      id: 805, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1, changedFields: 0x10,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 1, pos: { x: 1000, y: 0 }, posZ: 10, pathExp: true },
          { type: 1, pos: { x: 2000, y: 500 }, posZ: 15, pathExp: true },
          { type: 1, pos: { x: 3000, y: 1000 }, posZ: 20 },
        ],
      },
    },
    // Actions + turrets together
    {
      id: 806, type: 'unit', pos: { x: 100, y: 200, z: 0 }, rotation: 314, playerId: 1, changedFields: 0x30,
      unit: {
        hp: { curr: 75, max: 100 },
        velocity: { x: 10, y: 5, z: 0 },
        actions: [
          { type: 5, targetId: 888 },
        ],
        turrets: [
          {
            turret: {
              turretBlueprintCode: 7,
              angular: { rot: 1.5, vel: 0.2, pitch: 0.1, pitchVel: 0 },
            },
            targetId: 888,
            state: 2,
          },
        ],
      },
    },
    // Unit-shell under construction (build sub-object, incomplete)
    {
      id: 900, type: 'unit', pos: { x: 1000, y: 1000, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 5, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        build: {
          complete: false,
          paid: { energy: 25, metal: 15 },
        },
      },
    },
    // Newly completed shell (build sub-object, complete=true)
    {
      id: 901, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2, changedFields: 0x40,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        build: {
          complete: true,
          paid: { energy: 100, metal: 200 },
        },
      },
    },
    // Build sub-object with fractional resources + everything else
    // (a shell mid-construction that's also moving + tracking)
    {
      id: 902, type: 'unit', pos: { x: 500, y: 500, z: 0 }, rotation: 314, playerId: 1, changedFields: 0x4F,
      unit: {
        hp: { curr: 42.7, max: 100 },
        velocity: { x: 5, y: 0, z: 0 },
        build: {
          complete: false,
          paid: { energy: 33.3, metal: 55.5 },
        },
      },
    },
    // Build action with buildingBlueprintId string
    {
      id: 1000, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 7, buildingBlueprintId: 'factory', grid: { x: 10, y: 20 } },
        ],
      },
    },
    // Multiple build actions referencing the same string (slot dedup)
    {
      id: 1001, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 7, buildingBlueprintId: 'pylon', grid: { x: 0, y: 0 } },
          { type: 7, buildingBlueprintId: 'pylon', grid: { x: 5, y: 5 } },
        ],
      },
    },
    // Different string for each action (table grows)
    {
      id: 1002, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 7, buildingBlueprintId: 'commandCenter', grid: { x: 0, y: 0 } },
          { type: 7, buildingBlueprintId: 'energyConverter', grid: { x: 10, y: 0 } },
          { type: 7, buildingBlueprintId: 'extractor', grid: { x: 20, y: 0 } },
        ],
      },
    },
    // buildingBlueprintId with full action (everything optional present)
    {
      id: 1003, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1, changedFields: 0x10,
      unit: {
        hp: { curr: 75, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          {
            type: 7,
            pos: { x: 1234, y: 5678 },
            posZ: 42,
            targetId: 999,
            buildingBlueprintId: 'turret_defender',
            grid: { x: 50, y: 100 },
            buildingId: 88888,
          },
        ],
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const f of fixtures) {
    const wireFixture = sparseUnitFixture(f);
    const jsBytes = msgpackEncode(wireFixture, SNAPSHOT_ENCODE_OPTIONS);
    const typeTag = f.type === 'unit' ? SNAPSHOT_ENTITY_TYPE_UNIT : SNAPSHOT_ENTITY_TYPE_BUILDING;
    const hasChanged = f.changedFields !== undefined ? 1 : 0;
    const changed = f.changedFields ?? 0;
    const sn = f.unit.surfaceNormal;
    const hasNormal = sn !== undefined ? 1 : 0;
    const or = f.unit.orientation;
    const hasOrientation = or !== undefined ? 1 : 0;
    const av = f.unit.angularVelocity3;
    const hasAngularVelocity3 = av !== undefined ? 1 : 0;
    const hasFireEnabled = f.unit.fireEnabled === false ? 1 : 0;
    const hasIsCommander = f.unit.isCommander === true ? 1 : 0;
    const hasBuildTargetId = f.unit.buildTargetId !== undefined ? 1 : 0;
    const buildTargetIdIsNull = f.unit.buildTargetId === null ? 1 : 0;
    const buildTargetIdValue = typeof f.unit.buildTargetId === 'number' ? f.unit.buildTargetId : 0;
    const actions = f.unit.actions;
    const hasActions = actions !== undefined ? 1 : 0;
    const actionCount = actions?.length ?? 0;
    let stringSlots = new Map<string, number>();
    if (hasActions && actions) {
      const strings: string[] = [];
      for (const a of actions) {
        if (a.buildingBlueprintId !== undefined) strings.push(a.buildingBlueprintId);
      }
      if (strings.length > 0) {
        stringSlots = packStringsIntoScratch(memory, strings);
      }
      packActionsIntoScratch(memory, actions, stringSlots);
    }
    const turrets = f.unit.turrets;
    const hasTurrets = turrets !== undefined ? 1 : 0;
    const turretCount = turrets?.length ?? 0;
    if (hasTurrets && turrets) {
      packTurretsIntoScratch(memory, turrets);
    }
    const build = f.unit.build;
    const hasBuild = build !== undefined ? 1 : 0;
    const buildComplete = build?.complete === true ? 1 : 0;
    const buildPaidEnergy = build?.paid.energy ?? 0;
    const buildPaidMetal = build?.paid.metal ?? 0;
    messagepack_writer_clear();
    snapshot_encode_entity_unit(
      f.id, typeTag,
      f.pos.x, f.pos.y, f.pos.z,
      f.rotation, f.playerId,
      hasChanged, changed,
      f.unit.hp.curr, f.unit.hp.max,
      f.unit.velocity.x, f.unit.velocity.y, f.unit.velocity.z,
      f.unit.unitBlueprintCode !== undefined ? 1 : 0,
      f.unit.unitBlueprintCode ?? 0,
      f.unit.radius !== undefined ? 1 : 0,
      f.unit.radius?.body ?? 0,
      f.unit.radius?.shot ?? 0,
      f.unit.radius?.push ?? 0,
      f.unit.bodyCenterHeight !== undefined ? 1 : 0,
      f.unit.bodyCenterHeight ?? 0,
      f.unit.mass !== undefined ? 1 : 0,
      f.unit.mass ?? 0,
      hasNormal,
      sn?.nx ?? 0, sn?.ny ?? 0, sn?.nz ?? 0,
      hasOrientation,
      or?.x ?? 0, or?.y ?? 0, or?.z ?? 0, or?.w ?? 0,
      hasAngularVelocity3,
      av?.x ?? 0, av?.y ?? 0, av?.z ?? 0,
      hasFireEnabled,
      hasIsCommander,
      hasBuildTargetId,
      buildTargetIdIsNull,
      buildTargetIdValue,
      hasActions,
      actionCount,
      hasTurrets,
      turretCount,
      hasBuild,
      buildComplete,
      buildPaidEnergy,
      buildPaidMetal,
    );
    const ptr = messagepack_writer_ptr();
    const len = messagepack_writer_len();
    const rustBytes = new Uint8Array(memory.buffer, ptr, len).slice();
    if (bytesEqual(jsBytes, rustBytes)) {
      passed++;
    } else {
      failed++;
      console.error(
        '[snapshot encoder] unit byte mismatch',
        {
          fixture: f,
          jsLen: jsBytes.length,
          rustLen: rustBytes.length,
          jsHex: hex(jsBytes),
          rustHex: hex(rustBytes),
        },
      );
    }
  }
  return { passed, failed };
}

type WaypointFixture = {
  pos: { x: number; y: number };
  posZ?: number;
  type: string;
};

type FactoryFixture = {
  queue: number[];
  progress: number;
  producing: boolean;
  energyRate: number;
  metalRate: number;
  waypoints: WaypointFixture[];
};

type BuildingFixture = {
  id: number;
  type: 'building';
  pos: { x: number; y: number; z: number };
  rotation: number;
  playerId: number;
  changedFields?: number;
  building: {
    buildingBlueprintCode?: number;
    dim?: { x: number; y: number };
    hp: { curr: number; max: number };
    build: {
      complete: boolean;
      paid: { energy: number; metal: number };
    };
    metalExtractionRate?: number;
    solar?: { open: boolean };
    turrets?: TurretFixture[];
    factory?: FactoryFixture;
  };
};

function sparseBuildingFixture(f: BuildingFixture): BuildingFixture {
  if (f.changedFields === undefined) return f;
  return {
    ...sparseBasicFixture(f),
    building: {
      ...f.building,
      hp: fixtureHasField(f, ENTITY_CHANGED_HP) ? f.building.hp : undefined,
      build: fixtureHasField(f, ENTITY_CHANGED_BUILDING) ? f.building.build : undefined,
    },
  } as BuildingFixture;
}

function packFactoryQueueIntoScratch(memory: WebAssembly.Memory, queue: number[]): void {
  if (queue.length === 0) return;
  snapshot_encode_factory_queue_scratch_ensure(queue.length);
  const ptr = snapshot_encode_factory_queue_scratch_ptr();
  const view = new Uint32Array(memory.buffer, ptr, queue.length);
  for (let i = 0; i < queue.length; i++) view[i] = queue[i];
}

function packWaypointsIntoScratch(
  memory: WebAssembly.Memory,
  waypoints: WaypointFixture[],
  stringSlots: Map<string, number>,
): void {
  if (waypoints.length === 0) return;
  snapshot_encode_waypoint_scratch_ensure(waypoints.length);
  const ptr = snapshot_encode_waypoint_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, waypoints.length * WAYPOINT_SCRATCH_STRIDE);
  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    const base = i * WAYPOINT_SCRATCH_STRIDE;
    view[base + 0] = w.pos.x;
    view[base + 1] = w.pos.y;
    view[base + 2] = w.posZ !== undefined ? 1 : 0;
    view[base + 3] = w.posZ ?? 0;
    view[base + 4] = stringSlots.get(w.type) ?? 0;
  }
}

function runEntityBuildingCases(memory: WebAssembly.Memory): { passed: number; failed: number } {
  const fixtures: BuildingFixture[] = [
    // Minimal building (just hp + build, completed)
    {
      id: 2000, type: 'building', pos: { x: 1000, y: 1000, z: 0 }, rotation: 0, playerId: 1,
      building: {
        hp: { curr: 500, max: 500 },
        build: { complete: true, paid: { energy: 100, metal: 50 } },
      },
    },
    // Full record: type + dim + hp + build
    {
      id: 2001, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        buildingBlueprintCode: 2,
        dim: { x: 8, y: 8 },
        hp: { curr: 1000, max: 1000 },
        build: { complete: true, paid: { energy: 500, metal: 200 } },
      },
    },
    // Under-construction shell (incomplete build)
    {
      id: 2002, type: 'building', pos: { x: 200, y: 300, z: 50 }, rotation: 0, playerId: 2,
      building: {
        buildingBlueprintCode: 255,
        dim: { x: 4, y: 4 },
        hp: { curr: 30, max: 300 },
        build: { complete: false, paid: { energy: 25, metal: 10 } },
      },
    },
    // Extractor (has metalExtractionRate)
    {
      id: 2003, type: 'building', pos: { x: 100, y: 100, z: 0 }, rotation: 0, playerId: 1,
      building: {
        buildingBlueprintCode: 3,
        dim: { x: 4, y: 4 },
        hp: { curr: 200, max: 200 },
        build: { complete: true, paid: { energy: 50, metal: 100 } },
        metalExtractionRate: 12.5,
      },
    },
    // Solar panel (has solar.open)
    {
      id: 2004, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        buildingBlueprintCode: 0,
        dim: { x: 4, y: 4 },
        hp: { curr: 150, max: 150 },
        build: { complete: true, paid: { energy: 0, metal: 80 } },
        solar: { open: true },
      },
    },
    // Solar closed (panel folded for protection)
    {
      id: 2005, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        hp: { curr: 150, max: 150 },
        build: { complete: true, paid: { energy: 0, metal: 80 } },
        solar: { open: false },
      },
    },
    // Defense turret (has turrets array)
    {
      id: 2006, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2,
      building: {
        buildingBlueprintCode: 255,
        dim: { x: 2, y: 2 },
        hp: { curr: 400, max: 400 },
        build: { complete: true, paid: { energy: 100, metal: 100 } },
        turrets: [
          {
            turret: {
              turretBlueprintCode: 9,
              angular: { rot: 1.5, vel: 0.2, pitch: 0.5, pitchVel: 0 },
            },
            targetId: 1234,
            state: 2,
          },
        ],
      },
    },
    // Delta record (no type/dim) with hp change
    {
      id: 2007, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1, changedFields: 0x8,
      building: {
        hp: { curr: 950, max: 1000 },
        build: { complete: true, paid: { energy: 500, metal: 200 } },
      },
    },
    // Everything together — full record with all optional fields populated
    {
      id: 2008, type: 'building', pos: { x: 5000, y: 5000, z: 100 }, rotation: 0, playerId: 1,
      building: {
        buildingBlueprintCode: 3,
        dim: { x: 6, y: 6 },
        hp: { curr: 880, max: 1000 },
        build: { complete: true, paid: { energy: 200, metal: 300 } },
        metalExtractionRate: 25,
        solar: { open: true },
        turrets: [
          {
            turret: { turretBlueprintCode: 1, angular: { rot: 0, vel: 0, pitch: 0, pitchVel: 0 } },
            state: 0,
          },
        ],
      },
    },
    // Idle factory (empty queue, default rally point only)
    {
      id: 2100, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        buildingBlueprintCode: 2,
        dim: { x: 8, y: 8 },
        hp: { curr: 1000, max: 1000 },
        build: { complete: true, paid: { energy: 500, metal: 200 } },
        factory: {
          queue: [],
          progress: 0,
          producing: false,
          energyRate: 0,
          metalRate: 0,
          waypoints: [
            { pos: { x: 100, y: 100 }, type: 'move' },
          ],
        },
      },
    },
    // Active factory mid-production
    {
      id: 2101, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1, changedFields: 0x80,
      building: {
        hp: { curr: 1000, max: 1000 },
        build: { complete: true, paid: { energy: 500, metal: 200 } },
        factory: {
          queue: [3, 7, 12],
          progress: 0.42,
          producing: true,
          energyRate: 0.85,
          metalRate: 0.5,
          waypoints: [
            { pos: { x: 200, y: 200 }, type: 'move' },
          ],
        },
      },
    },
    // Factory with multi-step rally (rally point + player waypoints with posZ)
    {
      id: 2102, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2,
      building: {
        hp: { curr: 1000, max: 1000 },
        build: { complete: true, paid: { energy: 500, metal: 200 } },
        factory: {
          queue: [1],
          progress: 0.05,
          producing: true,
          energyRate: 0.3,
          metalRate: 0.3,
          waypoints: [
            { pos: { x: 100, y: 100 }, type: 'move' },
            { pos: { x: 500, y: 500 }, posZ: 50, type: 'move' },
            { pos: { x: 1000, y: 800 }, posZ: 75, type: 'patrol' },
          ],
        },
      },
    },
    // Full factory with everything
    {
      id: 2103, type: 'building', pos: { x: 2000, y: 2000, z: 0 }, rotation: 0, playerId: 1,
      building: {
        buildingBlueprintCode: 255,
        dim: { x: 10, y: 10 },
        hp: { curr: 5000, max: 5000 },
        build: { complete: true, paid: { energy: 0, metal: 0 } },
        factory: {
          queue: [99, 100, 101, 102],
          progress: 0.9,
          producing: true,
          energyRate: 1.0,
          metalRate: 0.7,
          waypoints: [
            { pos: { x: 2200, y: 2200 }, type: 'move' },
          ],
        },
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const f of fixtures) {
    const wireFixture = sparseBuildingFixture(f);
    const jsBytes = msgpackEncode(wireFixture, SNAPSHOT_ENCODE_OPTIONS);
    const hasChanged = f.changedFields !== undefined ? 1 : 0;
    const changed = f.changedFields ?? 0;
    const stringList: string[] = [];
    if (f.building.factory !== undefined) {
      for (const wp of f.building.factory.waypoints) stringList.push(wp.type);
    }
    const stringSlots = stringList.length > 0
      ? packStringsIntoScratch(memory, stringList)
      : new Map<string, number>();
    const turrets = f.building.turrets;
    const hasTurrets = turrets !== undefined ? 1 : 0;
    const turretCount = turrets?.length ?? 0;
    if (hasTurrets && turrets) {
      packTurretsIntoScratch(memory, turrets);
    }
    const factory = f.building.factory;
    const hasFactory = factory !== undefined ? 1 : 0;
    if (factory) {
      packFactoryQueueIntoScratch(memory, factory.queue);
      packWaypointsIntoScratch(memory, factory.waypoints, stringSlots);
    }
    messagepack_writer_clear();
    snapshot_encode_entity_building(
      f.id,
      f.pos.x, f.pos.y, f.pos.z,
      f.rotation, f.playerId,
      hasChanged, changed,
      f.building.buildingBlueprintCode !== undefined ? 1 : 0,
      f.building.buildingBlueprintCode ?? 0,
      f.building.dim !== undefined ? 1 : 0,
      f.building.dim?.x ?? 0, f.building.dim?.y ?? 0,
      f.building.hp.curr, f.building.hp.max,
      f.building.build.complete ? 1 : 0,
      f.building.build.paid.energy,
      f.building.build.paid.metal,
      f.building.metalExtractionRate !== undefined ? 1 : 0,
      f.building.metalExtractionRate ?? 0,
      f.building.solar !== undefined ? 1 : 0,
      f.building.solar?.open === true ? 1 : 0,
      hasTurrets,
      turretCount,
      hasFactory,
      factory?.queue.length ?? 0,
      factory?.progress ?? 0,
      factory?.producing === true ? 1 : 0,
      factory?.energyRate ?? 0,
      factory?.metalRate ?? 0,
      factory?.waypoints.length ?? 0,
    );
    const ptr = messagepack_writer_ptr();
    const len = messagepack_writer_len();
    const rustBytes = new Uint8Array(memory.buffer, ptr, len).slice();
    if (bytesEqual(jsBytes, rustBytes)) {
      passed++;
    } else {
      failed++;
      console.error(
        '[snapshot encoder] building byte mismatch',
        {
          fixture: f,
          jsLen: jsBytes.length,
          rustLen: rustBytes.length,
          jsHex: hex(jsBytes),
          rustHex: hex(rustBytes),
        },
      );
    }
  }
  return { passed, failed };
}

type MinimapEntityFixture = {
  id: number;
  pos: { x: number; y: number };
  type: 'unit' | 'building';
  playerId: number;
  radarOnly?: boolean;
};

type GameStateFixture = {
  phase: string;
  winnerId?: number;
};

const MINIMAP_SCRATCH_STRIDE = 6;

function packMinimapIntoScratch(
  memory: WebAssembly.Memory,
  entries: MinimapEntityFixture[],
): void {
  if (entries.length === 0) return;
  snapshot_encode_minimap_scratch_ensure(entries.length);
  const ptr = snapshot_encode_minimap_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, entries.length * MINIMAP_SCRATCH_STRIDE);
  for (let i = 0; i < entries.length; i++) {
    const m = entries[i];
    const base = i * MINIMAP_SCRATCH_STRIDE;
    view[base + 0] = m.id;
    view[base + 1] = m.pos.x;
    view[base + 2] = m.pos.y;
    view[base + 3] = m.type === 'unit' ? SNAPSHOT_ENTITY_TYPE_UNIT : SNAPSHOT_ENTITY_TYPE_BUILDING;
    view[base + 4] = m.playerId;
    // Pack: bit 0 = has, bit 1 = value
    let packed = 0;
    if (m.radarOnly !== undefined) {
      packed |= 0x01;
      if (m.radarOnly) packed |= 0x02;
    }
    view[base + 5] = packed;
  }
}

type NetworkMinimapFixture = NonNullable<NetworkServerSnapshot['minimapEntities']>;

function networkMinimapFixture(entries: MinimapEntityFixture[]): NetworkMinimapFixture {
  return entries.map((entry) => ({
    id: entry.id,
    pos: { x: entry.pos.x, y: entry.pos.y },
    type: entry.type,
    playerId: entry.playerId as NetworkMinimapFixture[number]['playerId'],
    radarOnly: entry.radarOnly === undefined ? null : entry.radarOnly,
  }));
}

type ProjectileSpawnFixture = {
  id: number;
  pos: { x: number; y: number; z: number };
  rotation: number;
  velocity: { x: number; y: number; z: number };
  projectileType: number;
  maxLifespan?: number;
  turretBlueprintCode: number;
  shotBlueprintCode?: number;
  sourceTurretBlueprintCode?: number;
  sourceTurretEntityId?: number;
  playerId: number;
  sourceEntityId: number;
  sourceHostEntityId?: number;
  sourceRootEntityId?: number;
  sourceTeamId?: number;
  spawnTick?: number;
  parentShotEntityId?: number;
  turretIndex: number;
  barrelIndex: number;
  isDGun?: boolean;
  fromParentDetonation?: boolean;
  beam?: { start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } };
  targetEntityId?: number;
  homingTurnRate?: number;
};
type ProjectileDespawnFixture = { id: number };
type ProjectileVelocityUpdateFixture = {
  id: number;
  pos: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  clearHomingTarget?: boolean;
};
type BeamPointFixture = {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  reflectorEntityId?: number;
  reflectorKind?: 'forceField';
  reflectorPlayerId?: number;
  normalX?: number;
  normalY?: number;
  normalZ?: number;
};
type BeamUpdateFixture = {
  id: number;
  points: BeamPointFixture[];
  obstructionT?: number;
  endpointDamageable?: boolean;
};
type ProjectilesFixture = {
  spawns?: ProjectileSpawnFixture[];
  despawns?: ProjectileDespawnFixture[];
  velocityUpdates?: ProjectileVelocityUpdateFixture[];
  beamUpdates?: BeamUpdateFixture[];
};

type NetworkProjectilesFixture = NonNullable<NetworkServerSnapshot['projectiles']>;

function networkProjectilesFixture(projectiles: ProjectilesFixture): NetworkProjectilesFixture {
  return {
    spawns: projectiles.spawns?.map((spawn) => ({
      id: spawn.id,
      pos: spawn.pos,
      rotation: spawn.rotation,
      velocity: spawn.velocity,
      projectileType: spawn.projectileType,
      maxLifespan: spawn.maxLifespan ?? null,
      turretBlueprintCode: spawn.turretBlueprintCode,
      shotBlueprintCode: spawn.shotBlueprintCode ?? null,
      sourceTurretBlueprintCode: spawn.sourceTurretBlueprintCode ?? null,
      sourceTurretEntityId: spawn.sourceTurretEntityId ?? null,
      playerId: spawn.playerId,
      sourceEntityId: spawn.sourceEntityId,
      sourceHostEntityId: spawn.sourceHostEntityId ?? spawn.sourceEntityId,
      sourceRootEntityId: spawn.sourceRootEntityId ?? spawn.sourceHostEntityId ?? spawn.sourceEntityId,
      sourceTeamId: spawn.sourceTeamId ?? spawn.playerId,
      spawnTick: spawn.spawnTick ?? 0,
      parentShotEntityId: spawn.parentShotEntityId ?? null,
      turretIndex: spawn.turretIndex,
      barrelIndex: spawn.barrelIndex,
      isDGun: spawn.isDGun ?? null,
      fromParentDetonation: spawn.fromParentDetonation ?? null,
      beam: spawn.beam ?? null,
      targetEntityId: spawn.targetEntityId ?? null,
      homingTurnRate: spawn.homingTurnRate ?? null,
    })),
    despawns: projectiles.despawns?.map((despawn) => ({ id: despawn.id })),
    velocityUpdates: projectiles.velocityUpdates?.map((update) => ({
      id: update.id,
      pos: update.pos,
      velocity: update.velocity,
      clearHomingTarget: update.clearHomingTarget ?? null,
    })),
    beamUpdates: projectiles.beamUpdates?.map((update) => ({
      id: update.id,
      points: update.points.map((point) => ({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: point.vx,
        vy: point.vy,
        vz: point.vz,
        reflectorEntityId: point.reflectorEntityId ?? null,
        reflectorKind: point.reflectorKind ?? null,
        reflectorPlayerId: point.reflectorPlayerId ?? null,
        normalX: point.normalX ?? null,
        normalY: point.normalY ?? null,
        normalZ: point.normalZ ?? null,
      })),
      obstructionT: update.obstructionT ?? null,
      endpointDamageable: update.endpointDamageable ?? null,
    })),
  };
}

const PROJ_SPAWN_SCRATCH_STRIDE = 32;
const PROJ_VEL_SCRATCH_STRIDE = 8;

function packProjSpawnsIntoScratch(memory: WebAssembly.Memory, spawns: ProjectileSpawnFixture[]): void {
  if (spawns.length === 0) return;
  snapshot_encode_proj_spawn_scratch_ensure(spawns.length);
  const ptr = snapshot_encode_proj_spawn_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, spawns.length * PROJ_SPAWN_SCRATCH_STRIDE);
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i];
    const base = i * PROJ_SPAWN_SCRATCH_STRIDE;
    view[base + 0] = s.id;
    view[base + 1] = s.pos.x;
    view[base + 2] = s.pos.y;
    view[base + 3] = s.pos.z;
    view[base + 4] = s.rotation;
    view[base + 5] = s.velocity.x;
    view[base + 6] = s.velocity.y;
    view[base + 7] = s.velocity.z;
    view[base + 8] = s.projectileType;
    view[base + 9] = s.maxLifespan ?? 0;
    view[base + 10] = s.turretBlueprintCode;
    view[base + 11] = s.shotBlueprintCode ?? 0;
    view[base + 12] = s.sourceTurretBlueprintCode ?? 0;
    view[base + 13] = s.playerId;
    view[base + 14] = s.sourceEntityId;
    view[base + 15] = s.turretIndex;
    view[base + 16] = s.barrelIndex;
    view[base + 17] = s.beam?.start.x ?? 0;
    view[base + 18] = s.beam?.start.y ?? 0;
    view[base + 19] = s.beam?.start.z ?? 0;
    view[base + 20] = s.beam?.end.x ?? 0;
    view[base + 21] = s.beam?.end.y ?? 0;
    view[base + 22] = s.beam?.end.z ?? 0;
    view[base + 23] = s.targetEntityId ?? 0;
    view[base + 24] = s.homingTurnRate ?? 0;
    view[base + 25] = s.sourceTurretEntityId ?? 0;
    view[base + 26] = s.sourceHostEntityId ?? s.sourceEntityId;
    view[base + 27] = s.sourceRootEntityId ?? s.sourceHostEntityId ?? s.sourceEntityId;
    view[base + 28] = s.sourceTeamId ?? s.playerId;
    view[base + 29] = s.spawnTick ?? 0;
    view[base + 30] = s.parentShotEntityId ?? 0;
    let flags = 0;
    if (s.maxLifespan !== undefined) flags |= 0x01;
    if (s.shotBlueprintCode !== undefined) flags |= 0x02;
    if (s.sourceTurretBlueprintCode !== undefined) flags |= 0x04;
    if (s.sourceTurretEntityId !== undefined) flags |= 0x400;
    if (s.parentShotEntityId !== undefined) flags |= 0x800;
    if (s.isDGun !== undefined) flags |= s.isDGun ? 0x08 : 0x100;
    if (s.fromParentDetonation !== undefined) flags |= s.fromParentDetonation ? 0x10 : 0x200;
    if (s.beam !== undefined) flags |= 0x20;
    if (s.targetEntityId !== undefined) flags |= 0x40;
    if (s.homingTurnRate !== undefined) flags |= 0x80;
    view[base + 31] = flags;
  }
}

function packProjDespawnsIntoScratch(memory: WebAssembly.Memory, ids: number[]): void {
  if (ids.length === 0) return;
  snapshot_encode_proj_despawn_scratch_ensure(ids.length);
  const ptr = snapshot_encode_proj_despawn_scratch_ptr();
  const view = new Uint32Array(memory.buffer, ptr, ids.length);
  for (let i = 0; i < ids.length; i++) view[i] = ids[i];
}

function packProjVelocityUpdatesIntoScratch(
  memory: WebAssembly.Memory,
  updates: ProjectileVelocityUpdateFixture[],
): void {
  if (updates.length === 0) return;
  snapshot_encode_proj_vel_scratch_ensure(updates.length);
  const ptr = snapshot_encode_proj_vel_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, updates.length * PROJ_VEL_SCRATCH_STRIDE);
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    const base = i * PROJ_VEL_SCRATCH_STRIDE;
    view[base + 0] = u.id;
    view[base + 1] = u.pos.x;
    view[base + 2] = u.pos.y;
    view[base + 3] = u.pos.z;
    view[base + 4] = u.velocity.x;
    view[base + 5] = u.velocity.y;
    view[base + 6] = u.velocity.z;
    view[base + 7] = u.clearHomingTarget === true ? 1 : 0;
  }
}

const BEAM_UPDATE_HEADER_STRIDE = 4;
const BEAM_POINT_STRIDE = 12;

function packBeamUpdatesIntoScratch(
  memory: WebAssembly.Memory,
  updates: BeamUpdateFixture[],
): number {
  if (updates.length === 0) return 0;
  snapshot_encode_beam_update_scratch_ensure(updates.length);
  let totalPoints = 0;
  for (const u of updates) totalPoints += u.points.length;
  if (totalPoints > 0) snapshot_encode_beam_point_scratch_ensure(totalPoints);

  const headerPtr = snapshot_encode_beam_update_scratch_ptr();
  const headerView = new Float64Array(
    memory.buffer, headerPtr, updates.length * BEAM_UPDATE_HEADER_STRIDE,
  );
  const pointPtr = snapshot_encode_beam_point_scratch_ptr();
  const pointView = totalPoints > 0
    ? new Float64Array(memory.buffer, pointPtr, totalPoints * BEAM_POINT_STRIDE)
    : new Float64Array(0);

  let pointOffset = 0;
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    const h = i * BEAM_UPDATE_HEADER_STRIDE;
    headerView[h + 0] = u.id;
    let flags = 0;
    if (u.obstructionT !== undefined) flags |= 0x01;
    if (u.endpointDamageable !== undefined) flags |= u.endpointDamageable ? 0x04 : 0x02;
    headerView[h + 1] = flags;
    headerView[h + 2] = u.obstructionT ?? 0;
    headerView[h + 3] = u.points.length;

    for (let p = 0; p < u.points.length; p++) {
      const pt = u.points[p];
      const pb = (pointOffset + p) * BEAM_POINT_STRIDE;
      pointView[pb + 0] = pt.x;
      pointView[pb + 1] = pt.y;
      pointView[pb + 2] = pt.z;
      pointView[pb + 3] = pt.vx;
      pointView[pb + 4] = pt.vy;
      pointView[pb + 5] = pt.vz;
      let pflags = 0;
      if (pt.reflectorEntityId !== undefined) pflags |= 0x01;
      if (pt.reflectorKind !== undefined) {
        pflags |= 0x02;
      }
      if (pt.reflectorPlayerId !== undefined) pflags |= 0x08;
      if (pt.normalX !== undefined) pflags |= 0x10;
      if (pt.normalY !== undefined) pflags |= 0x20;
      if (pt.normalZ !== undefined) pflags |= 0x40;
      pointView[pb + 6] = pflags;
      pointView[pb + 7] = pt.reflectorEntityId ?? 0;
      pointView[pb + 8] = pt.reflectorPlayerId ?? 0;
      pointView[pb + 9] = pt.normalX ?? 0;
      pointView[pb + 10] = pt.normalY ?? 0;
      pointView[pb + 11] = pt.normalZ ?? 0;
    }
    pointOffset += u.points.length;
  }
  return totalPoints;
}

type AudioEventType =
  | 'fire' | 'hit' | 'death' | 'laserStart' | 'laserStop'
  | 'forceFieldStart' | 'forceFieldStop' | 'forceFieldImpact'
  | 'ping' | 'attackAlert' | 'projectileExpire' | 'waterSplash';
type AudioEventSourceType = 'turret' | 'unit' | 'building' | 'system';

const AUDIO_EVENT_TYPE_CODES: Record<AudioEventType, number> = {
  fire: 0, hit: 1, death: 2, laserStart: 3, laserStop: 4,
  forceFieldStart: 5, forceFieldStop: 6, forceFieldImpact: 7,
  ping: 8, attackAlert: 9, projectileExpire: 10, waterSplash: 11,
};

const AUDIO_EVENT_SOURCE_TYPE_CODES: Record<AudioEventSourceType, number> = {
  turret: 0, unit: 1, building: 2, system: 3,
};

type DeathContextFixture = {
  unitVel: { x: number; y: number };
  hitDir: { x: number; y: number };
  projectileVel: { x: number; y: number };
  attackMagnitude: number;
  radius: number;
  visualRadius?: number;
  pushRadius?: number;
  baseZ?: number;
  color: number;
  unitBlueprintId?: string;
  rotation?: number;
  turretPoses?: Array<{ rotation: number; pitch: number }>;
};
type ImpactContextFixture = {
  collisionRadius: number;
  explosionRadius: number;
  projectile: { pos: { x: number; y: number }; vel: { x: number; y: number } };
  entity: { vel: { x: number; y: number }; collisionRadius: number };
  penetrationDir: { x: number; y: number };
};
type AudioEventFixture = {
  type: AudioEventType;
  turretBlueprintId: string;
  sourceType?: AudioEventSourceType;
  sourceKey?: string;
  pos: { x: number; y: number; z: number };
  playerId?: number;
  entityId?: number;
  forceFieldImpact?: {
    normal: { x: number; y: number; z: number };
    playerId: number;
  };
  killerPlayerId?: number;
  victimPlayerId?: number;
  audioOnly?: boolean;
  deathContext?: DeathContextFixture;
  impactContext?: ImpactContextFixture;
};

const DEATH_CONTEXT_STRIDE = 16;
const TURRET_POSE_STRIDE = 2;
const IMPACT_CONTEXT_STRIDE = 11;

function packDeathContextsIntoScratch(
  memory: WebAssembly.Memory,
  events: AudioEventFixture[],
  stringSlots: Map<string, number>,
): void {
  const deaths = events.filter((e) => e.deathContext !== undefined);
  if (deaths.length === 0) return;
  snapshot_encode_death_context_scratch_ensure(deaths.length);
  const ptr = snapshot_encode_death_context_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, deaths.length * DEATH_CONTEXT_STRIDE);

  let totalPoses = 0;
  for (const e of deaths) totalPoses += e.deathContext!.turretPoses?.length ?? 0;
  let poseView: Float64Array | undefined;
  if (totalPoses > 0) {
    snapshot_encode_turret_pose_scratch_ensure(totalPoses);
    const posePtr = snapshot_encode_turret_pose_scratch_ptr();
    poseView = new Float64Array(memory.buffer, posePtr, totalPoses * TURRET_POSE_STRIDE);
  }

  let poseOffset = 0;
  for (let i = 0; i < deaths.length; i++) {
    const dc = deaths[i].deathContext!;
    const base = i * DEATH_CONTEXT_STRIDE;
    view[base + 0] = dc.unitVel.x;
    view[base + 1] = dc.unitVel.y;
    view[base + 2] = dc.hitDir.x;
    view[base + 3] = dc.hitDir.y;
    view[base + 4] = dc.projectileVel.x;
    view[base + 5] = dc.projectileVel.y;
    view[base + 6] = dc.attackMagnitude;
    view[base + 7] = dc.radius;
    view[base + 8] = dc.color;
    view[base + 9] = dc.visualRadius ?? 0;
    view[base + 10] = dc.pushRadius ?? 0;
    view[base + 11] = dc.baseZ ?? 0;
    view[base + 12] = dc.rotation ?? 0;
    view[base + 13] = dc.unitBlueprintId !== undefined ? (stringSlots.get(dc.unitBlueprintId) ?? 0) : 0;
    view[base + 14] = dc.turretPoses?.length ?? 0;
    let flags = 0;
    if (dc.visualRadius !== undefined) flags |= 0x01;
    if (dc.pushRadius !== undefined) flags |= 0x02;
    if (dc.baseZ !== undefined) flags |= 0x04;
    if (dc.unitBlueprintId !== undefined) flags |= 0x08;
    if (dc.rotation !== undefined) flags |= 0x10;
    if (dc.turretPoses !== undefined) flags |= 0x20;
    view[base + 15] = flags;

    if (dc.turretPoses && poseView) {
      for (let p = 0; p < dc.turretPoses.length; p++) {
        const pose = dc.turretPoses[p];
        const pb = (poseOffset + p) * TURRET_POSE_STRIDE;
        poseView[pb + 0] = pose.rotation;
        poseView[pb + 1] = pose.pitch;
      }
      poseOffset += dc.turretPoses.length;
    }
  }
}

function packImpactContextsIntoScratch(
  memory: WebAssembly.Memory,
  events: AudioEventFixture[],
): void {
  const impacts = events.filter((e) => e.impactContext !== undefined);
  if (impacts.length === 0) return;
  snapshot_encode_impact_context_scratch_ensure(impacts.length);
  const ptr = snapshot_encode_impact_context_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, impacts.length * IMPACT_CONTEXT_STRIDE);
  for (let i = 0; i < impacts.length; i++) {
    const ic = impacts[i].impactContext!;
    const base = i * IMPACT_CONTEXT_STRIDE;
    view[base + 0] = ic.collisionRadius;
    view[base + 1] = ic.explosionRadius;
    view[base + 2] = ic.projectile.pos.x;
    view[base + 3] = ic.projectile.pos.y;
    view[base + 4] = ic.projectile.vel.x;
    view[base + 5] = ic.projectile.vel.y;
    view[base + 6] = ic.entity.vel.x;
    view[base + 7] = ic.entity.vel.y;
    view[base + 8] = ic.entity.collisionRadius;
    view[base + 9] = ic.penetrationDir.x;
    view[base + 10] = ic.penetrationDir.y;
  }
}

const AUDIO_EVENT_SCRATCH_STRIDE = 16;

function packAudioEventsIntoScratch(
  memory: WebAssembly.Memory,
  events: AudioEventFixture[],
  stringSlots: Map<string, number>,
): void {
  if (events.length === 0) return;
  snapshot_encode_audio_event_scratch_ensure(events.length);
  const ptr = snapshot_encode_audio_event_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, events.length * AUDIO_EVENT_SCRATCH_STRIDE);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const base = i * AUDIO_EVENT_SCRATCH_STRIDE;
    view[base + 0] = AUDIO_EVENT_TYPE_CODES[e.type];
    view[base + 1] = e.pos.x;
    view[base + 2] = e.pos.y;
    view[base + 3] = e.pos.z;
    view[base + 4] = e.playerId ?? 0;
    view[base + 5] = e.entityId ?? 0;
    view[base + 6] = e.killerPlayerId ?? 0;
    view[base + 7] = e.victimPlayerId ?? 0;
    view[base + 8] = e.forceFieldImpact?.normal.x ?? 0;
    view[base + 9] = e.forceFieldImpact?.normal.y ?? 0;
    view[base + 10] = e.forceFieldImpact?.normal.z ?? 0;
    view[base + 11] = e.forceFieldImpact?.playerId ?? 0;
    view[base + 12] = e.sourceType ? AUDIO_EVENT_SOURCE_TYPE_CODES[e.sourceType] : 0;
    view[base + 13] = stringSlots.get(e.turretBlueprintId) ?? 0;
    view[base + 14] = e.sourceKey !== undefined ? (stringSlots.get(e.sourceKey) ?? 0) : 0;
    let flags = 0;
    if (e.sourceType !== undefined) flags |= 0x001;
    if (e.sourceKey !== undefined) flags |= 0x002;
    if (e.playerId !== undefined) flags |= 0x004;
    if (e.entityId !== undefined) flags |= 0x008;
    if (e.forceFieldImpact !== undefined) flags |= 0x010;
    if (e.killerPlayerId !== undefined) flags |= 0x020;
    if (e.victimPlayerId !== undefined) flags |= 0x040;
    if (e.audioOnly !== undefined) {
      flags |= 0x080;
      if (e.audioOnly) flags |= 0x100;
    }
    if (e.deathContext !== undefined) flags |= 0x200;
    if (e.impactContext !== undefined) flags |= 0x400;
    view[base + 15] = flags;
  }
}

type EconomyPlayerFixture = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number };
  expenditure: number;
  metal: {
    stockpile: { curr: number; max: number };
    income: { base: number; extraction: number };
    expenditure: number;
  };
};
type EconomyFixture = Record<number, EconomyPlayerFixture>;

const ECONOMY_SCRATCH_STRIDE = 11;

function packEconomyIntoScratch(
  memory: WebAssembly.Memory,
  economy: EconomyFixture,
): number {
  const ids = Object.keys(economy).map(Number).sort((a, b) => a - b);
  if (ids.length === 0) return 0;
  snapshot_encode_economy_scratch_ensure(ids.length);
  const ptr = snapshot_encode_economy_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, ids.length * ECONOMY_SCRATCH_STRIDE);
  for (let i = 0; i < ids.length; i++) {
    const pid = ids[i];
    const e = economy[pid];
    const base = i * ECONOMY_SCRATCH_STRIDE;
    view[base + 0] = pid;
    view[base + 1] = e.stockpile.curr;
    view[base + 2] = e.stockpile.max;
    view[base + 3] = e.income.base;
    view[base + 4] = e.income.production;
    view[base + 5] = e.expenditure;
    view[base + 6] = e.metal.stockpile.curr;
    view[base + 7] = e.metal.stockpile.max;
    view[base + 8] = e.metal.income.base;
    view[base + 9] = e.metal.income.extraction;
    view[base + 10] = e.metal.expenditure;
  }
  return ids.length;
}

type SprayTargetFixture = {
  source: { id: number; pos: { x: number; y: number }; z?: number; playerId: number };
  target: {
    id: number;
    pos: { x: number; y: number };
    z?: number;
    dim?: { x: number; y: number };
    radius?: number;
  };
  type: 'build' | 'heal';
  intensity: number;
  speed?: number;
  particleRadius?: number;
};

const SPRAY_SCRATCH_STRIDE = 16;

function packSprayTargetsIntoScratch(
  memory: WebAssembly.Memory,
  sprays: SprayTargetFixture[],
): void {
  if (sprays.length === 0) return;
  snapshot_encode_spray_scratch_ensure(sprays.length);
  const ptr = snapshot_encode_spray_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, sprays.length * SPRAY_SCRATCH_STRIDE);
  for (let i = 0; i < sprays.length; i++) {
    const s = sprays[i];
    const base = i * SPRAY_SCRATCH_STRIDE;
    view[base + 0] = s.source.id;
    view[base + 1] = s.source.pos.x;
    view[base + 2] = s.source.pos.y;
    view[base + 3] = s.source.z ?? 0;
    view[base + 4] = s.source.playerId;
    view[base + 5] = s.target.id;
    view[base + 6] = s.target.pos.x;
    view[base + 7] = s.target.pos.y;
    view[base + 8] = s.target.z ?? 0;
    view[base + 9] = s.target.dim?.x ?? 0;
    view[base + 10] = s.target.dim?.y ?? 0;
    view[base + 11] = s.target.radius ?? 0;
    view[base + 12] = s.intensity;
    view[base + 13] = s.speed ?? 0;
    view[base + 14] = s.particleRadius ?? 0;
    let flags = 0;
    if (s.type === 'heal') flags |= 0x01;
    if (s.source.z !== undefined) flags |= 0x02;
    if (s.target.z !== undefined) flags |= 0x04;
    if (s.target.dim !== undefined) flags |= 0x08;
    if (s.target.radius !== undefined) flags |= 0x10;
    if (s.speed !== undefined) flags |= 0x20;
    if (s.particleRadius !== undefined) flags |= 0x40;
    view[base + 15] = flags;
  }
}

type ShroudFixture = {
  gridW: number;
  gridH: number;
  cellSize: number;
  bitmap: Uint8Array;
};

function packShroudBitmapIntoScratch(
  memory: WebAssembly.Memory,
  bitmap: Uint8Array,
): void {
  if (bitmap.length === 0) return;
  snapshot_encode_shroud_scratch_ensure(bitmap.length);
  const ptr = snapshot_encode_shroud_scratch_ptr();
  const view = new Uint8Array(memory.buffer, ptr, bitmap.length);
  view.set(bitmap);
}

const _numberArrayOffsets: number[] = [];

function packNumberArraysIntoScratch(
  memory: WebAssembly.Memory,
  arrays: readonly (readonly number[])[],
): readonly number[] {
  _numberArrayOffsets.length = 0;
  let total = 0;
  for (let i = 0; i < arrays.length; i++) {
    _numberArrayOffsets.push(total);
    total += arrays[i].length;
  }
  snapshot_encode_number_scratch_ensure(Math.max(total, 1));
  const ptr = snapshot_encode_number_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, total);
  let offset = 0;
  for (let i = 0; i < arrays.length; i++) {
    const src = arrays[i];
    for (let j = 0; j < src.length; j++) {
      view[offset + j] = src[j];
    }
    offset += src.length;
  }
  return _numberArrayOffsets;
}

type TerrainFixture = {
  mapWidth: number;
  mapHeight: number;
  cellSize: number;
  subdiv: number;
  cellsX: number;
  cellsY: number;
  verticesX: number;
  verticesY: number;
  version: number;
  meshVertexCoords: number[];
  meshVertexHeights: number[];
  meshTriangleIndices: number[];
  meshTriangleLevels: number[];
  meshTriangleNeighborIndices: number[];
  meshTriangleNeighborLevels: number[];
  meshCellTriangleOffsets: number[];
  meshCellTriangleIndices: number[];
};

function emitTerrainFixture(memory: WebAssembly.Memory, terrain: TerrainFixture): void {
  const arrays = [
    terrain.meshVertexCoords,
    terrain.meshVertexHeights,
    terrain.meshTriangleIndices,
    terrain.meshTriangleLevels,
    terrain.meshTriangleNeighborIndices,
    terrain.meshTriangleNeighborLevels,
    terrain.meshCellTriangleOffsets,
    terrain.meshCellTriangleIndices,
  ] as const;
  const offsets = packNumberArraysIntoScratch(memory, arrays);
  snapshot_encode_envelope_emit_terrain(
    terrain.mapWidth,
    terrain.mapHeight,
    terrain.cellSize,
    terrain.subdiv,
    terrain.cellsX,
    terrain.cellsY,
    terrain.verticesX,
    terrain.verticesY,
    terrain.version,
    offsets[0], terrain.meshVertexCoords.length,
    offsets[1], terrain.meshVertexHeights.length,
    offsets[2], terrain.meshTriangleIndices.length,
    offsets[3], terrain.meshTriangleLevels.length,
    offsets[4], terrain.meshTriangleNeighborIndices.length,
    offsets[5], terrain.meshTriangleNeighborLevels.length,
    offsets[6], terrain.meshCellTriangleOffsets.length,
    offsets[7], terrain.meshCellTriangleIndices.length,
  );
}

function emitPackedTerrainFixture(memory: WebAssembly.Memory, terrain: TerrainFixture): void {
  const arrays = [
    terrain.meshVertexCoords,
    terrain.meshVertexHeights,
    terrain.meshTriangleIndices,
  ] as const;
  const offsets = packNumberArraysIntoScratch(memory, arrays);
  snapshot_encode_envelope_emit_packed_terrain(
    terrain.mapWidth,
    terrain.mapHeight,
    terrain.cellSize,
    terrain.subdiv,
    terrain.cellsX,
    terrain.cellsY,
    terrain.verticesX,
    terrain.verticesY,
    terrain.version,
    offsets[0], terrain.meshVertexCoords.length,
    offsets[1], terrain.meshVertexHeights.length,
    offsets[2], terrain.meshTriangleIndices.length,
  );
}

type BuildabilityFixture = {
  mapWidth: number;
  mapHeight: number;
  cellSize: number;
  cellsX: number;
  cellsY: number;
  version: number;
  configKey: string;
  flags: number[];
  levels: number[];
};

function emitBuildabilityFixture(memory: WebAssembly.Memory, buildability: BuildabilityFixture): void {
  const offsets = packNumberArraysIntoScratch(memory, [buildability.flags, buildability.levels]);
  packStringsIntoScratch(memory, [buildability.configKey]);
  snapshot_encode_envelope_emit_buildability(
    buildability.mapWidth,
    buildability.mapHeight,
    buildability.cellSize,
    buildability.cellsX,
    buildability.cellsY,
    buildability.version,
    0,
    offsets[0], buildability.flags.length,
    offsets[1], buildability.levels.length,
  );
}

function emitPackedBuildabilityFixture(
  memory: WebAssembly.Memory,
  buildability: BuildabilityFixture,
): void {
  const offsets = packNumberArraysIntoScratch(memory, [buildability.flags, buildability.levels]);
  packStringsIntoScratch(memory, [buildability.configKey]);
  snapshot_encode_envelope_emit_packed_buildability(
    buildability.mapWidth,
    buildability.mapHeight,
    buildability.cellSize,
    buildability.cellsX,
    buildability.cellsY,
    buildability.version,
    0,
    offsets[0], buildability.flags.length,
    offsets[1], buildability.levels.length,
  );
}

type ScanPulseFixture = {
  playerId: number;
  x: number; y: number; z: number;
  radius: number;
  expiresAtTick: number;
};

const SCAN_PULSE_SCRATCH_STRIDE = 6;

function packScanPulsesIntoScratch(
  memory: WebAssembly.Memory,
  pulses: ScanPulseFixture[],
): void {
  if (pulses.length === 0) return;
  snapshot_encode_scan_pulse_scratch_ensure(pulses.length);
  const ptr = snapshot_encode_scan_pulse_scratch_ptr();
  const view = new Float64Array(memory.buffer, ptr, pulses.length * SCAN_PULSE_SCRATCH_STRIDE);
  for (let i = 0; i < pulses.length; i++) {
    const p = pulses[i];
    const base = i * SCAN_PULSE_SCRATCH_STRIDE;
    view[base + 0] = p.playerId;
    view[base + 1] = p.x;
    view[base + 2] = p.y;
    view[base + 3] = p.z;
    view[base + 4] = p.radius;
    view[base + 5] = p.expiresAtTick;
  }
}

type EnvelopeFixture = {
  tick: number;
  entities: (UnitFixture | BuildingFixture)[];
  minimapEntities?: MinimapEntityFixture[];
  economy: EconomyFixture;
  sprayTargets?: SprayTargetFixture[];
  audioEvents?: AudioEventFixture[];
  projectiles?: ProjectilesFixture;
  gameState?: GameStateFixture;
  isDelta: boolean;
  removedEntityIds?: number[];
  visibilityFiltered?: boolean;
  scanPulses?: ScanPulseFixture[];
  shroud?: ShroudFixture;
  terrain?: TerrainFixture;
  buildability?: BuildabilityFixture;
};

function sparseEnvelopeFixture(f: EnvelopeFixture): EnvelopeFixture {
  return {
    ...f,
    entities: f.entities.map((entity) =>
      entity.type === 'unit'
        ? sparseUnitFixture(entity as UnitFixture)
        : sparseBuildingFixture(entity as BuildingFixture),
    ),
    projectiles: sparseProjectilesFixture(f.projectiles),
  };
}

function sparseProjectilesFixture(
  projectiles: ProjectilesFixture | undefined,
): ProjectilesFixture | undefined {
  if (projectiles === undefined) return undefined;
  return {
    ...projectiles,
    spawns: projectiles.spawns?.map(sparseProjectileSpawnFixture),
  };
}

function sparseProjectileSpawnFixture(
  spawn: ProjectileSpawnFixture,
): ProjectileSpawnFixture {
  const sourceHostEntityId = spawn.sourceHostEntityId ?? spawn.sourceEntityId;
  const out = {
    id: spawn.id,
    pos: spawn.pos,
    rotation: spawn.rotation,
    velocity: spawn.velocity,
    projectileType: spawn.projectileType,
  } as ProjectileSpawnFixture;
  if (spawn.maxLifespan !== undefined) out.maxLifespan = spawn.maxLifespan;
  out.turretBlueprintCode = spawn.turretBlueprintCode;
  if (spawn.shotBlueprintCode !== undefined) out.shotBlueprintCode = spawn.shotBlueprintCode;
  if (spawn.sourceTurretBlueprintCode !== undefined) out.sourceTurretBlueprintCode = spawn.sourceTurretBlueprintCode;
  if (spawn.sourceTurretEntityId !== undefined) {
    out.sourceTurretEntityId = spawn.sourceTurretEntityId;
  }
  out.playerId = spawn.playerId;
  out.sourceEntityId = spawn.sourceEntityId;
  out.sourceHostEntityId = sourceHostEntityId;
  out.sourceRootEntityId = spawn.sourceRootEntityId ?? sourceHostEntityId;
  out.sourceTeamId = spawn.sourceTeamId ?? spawn.playerId;
  out.spawnTick = spawn.spawnTick ?? 0;
  if (spawn.parentShotEntityId !== undefined) out.parentShotEntityId = spawn.parentShotEntityId;
  out.turretIndex = spawn.turretIndex;
  out.barrelIndex = spawn.barrelIndex;
  if (spawn.isDGun !== undefined) out.isDGun = spawn.isDGun;
  if (spawn.fromParentDetonation !== undefined) {
    out.fromParentDetonation = spawn.fromParentDetonation;
  }
  if (spawn.beam !== undefined) out.beam = spawn.beam;
  if (spawn.targetEntityId !== undefined) out.targetEntityId = spawn.targetEntityId;
  if (spawn.homingTurnRate !== undefined) out.homingTurnRate = spawn.homingTurnRate;
  return out;
}

function packRemovedIdsIntoScratch(memory: WebAssembly.Memory, ids: number[]): void {
  if (ids.length === 0) return;
  snapshot_encode_removed_ids_scratch_ensure(ids.length);
  const ptr = snapshot_encode_removed_ids_scratch_ptr();
  const view = new Uint32Array(memory.buffer, ptr, ids.length);
  for (let i = 0; i < ids.length; i++) view[i] = ids[i];
}

function runEnvelopeCases(memory: WebAssembly.Memory): { passed: number; failed: number } {
  const fixtures: EnvelopeFixture[] = [
    // Empty envelope — no entities, just shell
    { tick: 0, entities: [], economy: {}, isDelta: false },
    // Single tick
    { tick: 1, entities: [], economy: {}, isDelta: true },
    // Large tick value (forces u32-range encoding)
    { tick: 1_000_000, entities: [], economy: {}, isDelta: false },
    // One unit entity
    {
      tick: 42, entities: [
        {
          id: 100, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
          unit: { hp: { curr: 100, max: 100 }, velocity: { x: 0, y: 0, z: 0 } },
        },
      ], economy: {}, isDelta: true,
    },
    // One building entity
    {
      tick: 99, entities: [
        {
          id: 200, type: 'building', pos: { x: 1000, y: 1000, z: 0 }, rotation: 0, playerId: 1,
          building: {
            hp: { curr: 500, max: 500 },
            build: { complete: true, paid: { energy: 100, metal: 50 } },
          },
        },
      ], economy: {}, isDelta: false,
    },
    // Mixed: one unit + one building
    {
      tick: 7, entities: [
        {
          id: 1, type: 'unit', pos: { x: 50, y: 50, z: 10 }, rotation: 314, playerId: 1, changedFields: 5,
          unit: {
            hp: { curr: 80, max: 100 },
            velocity: { x: 10, y: -5, z: 0 },
            surfaceNormal: { nx: 0, ny: 0, nz: 1000 },
          },
        },
        {
          id: 2, type: 'building', pos: { x: 500, y: 500, z: 0 }, rotation: 0, playerId: 1,
          building: {
            buildingBlueprintCode: 255,
            dim: { x: 4, y: 4 },
            hp: { curr: 300, max: 300 },
            build: { complete: true, paid: { energy: 50, metal: 30 } },
          },
        },
      ], economy: {}, isDelta: true,
    },
    // removedEntityIds present (single removal)
    {
      tick: 100, entities: [], economy: {}, isDelta: true,
      removedEntityIds: [42],
    },
    // removedEntityIds with multiple ids
    {
      tick: 101, entities: [], economy: {}, isDelta: true,
      removedEntityIds: [1, 2, 3, 999, 1_000_000],
    },
    // visibilityFiltered true (FOW snapshot)
    {
      tick: 200, entities: [], economy: {}, isDelta: false,
      visibilityFiltered: true,
    },
    // visibilityFiltered false (full snapshot)
    {
      tick: 201, entities: [], economy: {}, isDelta: false,
      visibilityFiltered: false,
    },
    // Everything together — entities + removed + visibility
    {
      tick: 300, entities: [
        {
          id: 5, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
          unit: { hp: { curr: 100, max: 100 }, velocity: { x: 0, y: 0, z: 0 } },
        },
      ], economy: {}, isDelta: true,
      removedEntityIds: [10, 11],
      visibilityFiltered: true,
    },
    // gameState during battle (phase only). Property order must
    // match stateSerializer.ts:_snapshotBuf pool: tick, entities,
    // economy, gameState, isDelta. msgpackEncode walks JS object
    // insertion order so the fixture must place gameState BEFORE
    // isDelta to match the Rust emit sequence.
    {
      tick: 400, entities: [], economy: {},
      gameState: { phase: 'battle' },
      isDelta: true,
    },
    // gameState at game over with winner
    {
      tick: 401, entities: [], economy: {},
      gameState: { phase: 'gameOver', winnerId: 1 },
      isDelta: false,
    },
    // minimapEntities — pool order puts minimapEntities BETWEEN
    // entities and economy, so the fixture's literal-property order
    // matches.
    {
      tick: 500, entities: [],
      minimapEntities: [
        { id: 1, pos: { x: 100, y: 100 }, type: 'unit', playerId: 1 },
        { id: 2, pos: { x: 200, y: 300 }, type: 'building', playerId: 2 },
        { id: 3, pos: { x: -50, y: 0 }, type: 'unit', playerId: 3, radarOnly: true },
      ],
      economy: {}, isDelta: true,
    },
    // minimapEntities + gameState + visibility — busier envelope
    {
      tick: 600, entities: [
        {
          id: 10, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
          unit: { hp: { curr: 100, max: 100 }, velocity: { x: 0, y: 0, z: 0 } },
        },
      ],
      minimapEntities: [
        { id: 10, pos: { x: 0, y: 0 }, type: 'unit', playerId: 1 },
        { id: 11, pos: { x: 500, y: 500 }, type: 'building', playerId: 2 },
      ],
      economy: {}, gameState: { phase: 'battle' }, isDelta: true,
      removedEntityIds: [99],
      visibilityFiltered: true,
    },
    // projectiles.despawns only
    {
      tick: 700, entities: [], economy: {},
      projectiles: { despawns: [{ id: 1001 }, { id: 1002 }] },
      isDelta: true,
    },
    // projectiles.velocityUpdates only (mid-flight projectile)
    {
      tick: 701, entities: [], economy: {},
      projectiles: {
        velocityUpdates: [
          { id: 2001, pos: { x: 100, y: 200, z: 50 }, velocity: { x: 25, y: 10, z: 5 }, clearHomingTarget: true },
        ],
      },
      isDelta: true,
    },
    // projectiles with both despawns AND velocityUpdates
    {
      tick: 702, entities: [], economy: {},
      projectiles: {
        despawns: [{ id: 3001 }],
        velocityUpdates: [
          { id: 3002, pos: { x: 0, y: 0, z: 100 }, velocity: { x: 0, y: 0, z: -9.8 } },
          { id: 3003, pos: { x: 500, y: 500, z: 0 }, velocity: { x: -10, y: 5, z: 0 } },
        ],
      },
      isDelta: true,
    },
    // projectiles + everything else
    {
      tick: 703, entities: [
        {
          id: 20, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
          unit: { hp: { curr: 100, max: 100 }, velocity: { x: 0, y: 0, z: 0 } },
        },
      ],
      minimapEntities: [
        { id: 20, pos: { x: 0, y: 0 }, type: 'unit', playerId: 1 },
      ],
      economy: {},
      projectiles: {
        despawns: [{ id: 50 }],
        velocityUpdates: [
          { id: 51, pos: { x: 1000, y: 0, z: 50 }, velocity: { x: 100, y: 0, z: 0 } },
        ],
      },
      gameState: { phase: 'battle' },
      isDelta: true,
      removedEntityIds: [10],
      visibilityFiltered: false,
    },
    // projectiles.spawns — single minimal spawn (required fields only).
    {
      tick: 800, entities: [], economy: {},
      projectiles: {
        spawns: [{
          id: 9001,
          pos: { x: 100, y: 200, z: 50 },
          rotation: 0,
          velocity: { x: 0, y: 0, z: 0 },
          projectileType: 1,
          turretBlueprintCode: 2,
          playerId: 1,
          sourceEntityId: 500,
          turretIndex: 0,
          barrelIndex: 0,
        }],
      },
      isDelta: true,
    },
    // projectiles.spawns — every optional field set.
    {
      tick: 801, entities: [], economy: {},
      projectiles: {
        spawns: [{
          id: 9002,
          pos: { x: 0, y: 0, z: 0 },
          rotation: 1.5708,
          velocity: { x: 100, y: 0, z: 50 },
          projectileType: 3,
          maxLifespan: 5000,
          turretBlueprintCode: 4,
          shotBlueprintCode: 7,
          sourceTurretBlueprintCode: 8,
          sourceTurretEntityId: 88,
          playerId: 2,
          sourceEntityId: 600,
          sourceHostEntityId: 600,
          sourceRootEntityId: 590,
          sourceTeamId: 2,
          spawnTick: 777,
          parentShotEntityId: 8999,
          turretIndex: 1,
          barrelIndex: 2,
          isDGun: true,
          fromParentDetonation: true,
          beam: {
            start: { x: 0, y: 0, z: 10 },
            end: { x: 1000, y: 500, z: 10 },
          },
          targetEntityId: 700,
          homingTurnRate: 0.5,
        }],
      },
      isDelta: true,
    },
    // projectiles.spawns — multiple, mix of optional combos.
    {
      tick: 802, entities: [], economy: {},
      projectiles: {
        spawns: [
          {
            id: 9003,
            pos: { x: 500, y: 500, z: 0 },
            rotation: 3.14,
            velocity: { x: -50, y: 0, z: 0 },
            projectileType: 2,
            turretBlueprintCode: 1,
            playerId: 1,
            sourceEntityId: 0,
            turretIndex: 0,
            barrelIndex: 0,
            isDGun: true,
          },
          {
            id: 9004,
            pos: { x: -100, y: 200, z: 75 },
            rotation: 0,
            velocity: { x: 0, y: 100, z: 0 },
            projectileType: 5,
            maxLifespan: 3000,
            turretBlueprintCode: 6,
            playerId: 3,
            sourceEntityId: 800,
            turretIndex: 2,
            barrelIndex: 1,
            targetEntityId: 900,
            homingTurnRate: 1.2,
          },
        ],
      },
      isDelta: true,
    },
    // projectiles with spawns + despawns + velocityUpdates.
    {
      tick: 803, entities: [], economy: {},
      projectiles: {
        spawns: [{
          id: 9005,
          pos: { x: 0, y: 0, z: 0 },
          rotation: 0,
          velocity: { x: 50, y: 0, z: 0 },
          projectileType: 1,
          turretBlueprintCode: 2,
          playerId: 1,
          sourceEntityId: 100,
          turretIndex: 0,
          barrelIndex: 0,
        }],
        despawns: [{ id: 8000 }, { id: 8001 }],
        velocityUpdates: [
          { id: 7000, pos: { x: 50, y: 0, z: 50 }, velocity: { x: 25, y: 0, z: 0 } },
        ],
      },
      isDelta: true,
    },
    // scanPulses — single pulse, all-required field shape.
    {
      tick: 1000, entities: [], economy: {}, isDelta: true,
      scanPulses: [
        { playerId: 1, x: 5000, y: 6000, z: 0, radius: 800, expiresAtTick: 1064 },
      ],
    },
    // scanPulses — multiple pulses, varied owners + tick offsets.
    {
      tick: 1001, entities: [], economy: {}, isDelta: true,
      scanPulses: [
        { playerId: 1, x: 100, y: 200, z: 0, radius: 1000, expiresAtTick: 1065 },
        { playerId: 2, x: -500, y: 300, z: 50, radius: 1500, expiresAtTick: 1090 },
        { playerId: 3, x: 0, y: 0, z: 0, radius: 600, expiresAtTick: 1101 },
      ],
    },
    // audioEvents belongs before isDelta in the production _snapshotBuf
    // insertion order.
    // audioEvents — single fire event, minimum fields.
    {
      tick: 1400, entities: [], economy: {},
      audioEvents: [{
        type: 'fire',
        turretBlueprintId: 'turret.cannon',
        pos: { x: 500, y: 500, z: 12 },
      }],
      isDelta: true,
    },
    // audioEvents — laserStart with playerId + sourceType + sourceKey.
    {
      tick: 1401, entities: [], economy: {},
      audioEvents: [{
        type: 'laserStart',
        turretBlueprintId: 'turret.laser',
        sourceType: 'turret',
        sourceKey: 'turret.laser#0',
        pos: { x: 100, y: 200, z: 0 },
        playerId: 1,
        entityId: 42,
      }],
      isDelta: true,
    },
    // audioEvents — forceFieldImpact with the nested normal vec.
    {
      tick: 1402, entities: [], economy: {},
      audioEvents: [{
        type: 'forceFieldImpact',
        turretBlueprintId: '',  // empty-string turretBlueprintId is valid (fixstr 0xA0)
        pos: { x: 300, y: 400, z: 50 },
        forceFieldImpact: {
          normal: { x: 0.707, y: 0.707, z: 0 },
          playerId: 2,
        },
      }],
      isDelta: true,
    },
    // audioEvents — attackAlert with victimPlayerId + audioOnly=true.
    {
      tick: 1403, entities: [], economy: {},
      audioEvents: [{
        type: 'attackAlert',
        turretBlueprintId: 'shot.rocket',
        pos: { x: -100, y: -200, z: 0 },
        playerId: 3,
        victimPlayerId: 1,
        audioOnly: true,
      }],
      isDelta: true,
    },
    // audioEvents — death with killerPlayerId; deathContext omitted
    // (handled in D.3j-27 follow-up).
    {
      tick: 1404, entities: [], economy: {},
      audioEvents: [{
        type: 'death',
        turretBlueprintId: 'unit.tank',
        sourceType: 'unit',
        pos: { x: 800, y: 800, z: 5 },
        playerId: 2,
        entityId: 100,
        killerPlayerId: 1,
      }],
      isDelta: true,
    },
    // audioEvents — multiple events in one snapshot mixing types.
    {
      tick: 1405, entities: [], economy: {},
      audioEvents: [
        { type: 'fire', turretBlueprintId: 'turret.cannon', pos: { x: 0, y: 0, z: 0 } },
        { type: 'hit', turretBlueprintId: 'shot.shell', pos: { x: 100, y: 100, z: 0 }, entityId: 50 },
        { type: 'projectileExpire', turretBlueprintId: 'shot.shell', pos: { x: 200, y: 200, z: 10 } },
        { type: 'ping', turretBlueprintId: '', pos: { x: 0, y: 0, z: 0 }, playerId: 1, audioOnly: false },
      ],
      isDelta: true,
    },
    // audioEvents — death with deathContext (no turretPoses, no
    // unitBlueprintId — building-style death).
    {
      tick: 1410, entities: [], economy: {},
      audioEvents: [{
        type: 'death',
        turretBlueprintId: 'unit.pylon',
        sourceType: 'building',
        pos: { x: 1000, y: 1000, z: 0 },
        entityId: 200,
        deathContext: {
          unitVel: { x: 0, y: 0 },
          hitDir: { x: 0, y: -1 },
          projectileVel: { x: 0, y: 0 },
          attackMagnitude: 50,
          radius: 80,
          visualRadius: 80,
          pushRadius: 4,
          baseZ: 0,
          color: 0xFF8800,
        },
      }],
      isDelta: true,
    },
    // audioEvents — death with full deathContext (unit-style: every
    // optional populated + nested turretPoses array).
    {
      tick: 1411, entities: [], economy: {},
      audioEvents: [{
        type: 'death',
        turretBlueprintId: 'unit.tank',
        sourceType: 'unit',
        pos: { x: 500, y: 500, z: 12 },
        entityId: 300,
        deathContext: {
          unitVel: { x: 10, y: -5 },
          hitDir: { x: 0.707, y: 0.707 },
          projectileVel: { x: 50, y: 0 },
          attackMagnitude: 120,
          radius: 40,
          visualRadius: 35,
          pushRadius: 30,
          baseZ: 10,
          color: 0xFF0000,
          unitBlueprintId: 'tank',
          rotation: 1.5708,
          turretPoses: [
            { rotation: 0.5, pitch: 0.2 },
            { rotation: -0.3, pitch: 0 },
          ],
        },
        killerPlayerId: 2,
      }],
      isDelta: true,
    },
    // audioEvents — hit with impactContext (all required nested vecs).
    {
      tick: 1412, entities: [], economy: {},
      audioEvents: [{
        type: 'hit',
        turretBlueprintId: 'shot.shell',
        pos: { x: 600, y: 600, z: 5 },
        entityId: 400,
        impactContext: {
          collisionRadius: 8,
          explosionRadius: 24,
          projectile: { pos: { x: 600, y: 600 }, vel: { x: 50, y: 0 } },
          entity: { vel: { x: 0, y: 0 }, collisionRadius: 12 },
          penetrationDir: { x: 1, y: 0 },
        },
      }],
      isDelta: true,
    },
    // audioEvents — multiple deaths + hits + plain events in one tick
    // (validates the per-context offset walker).
    {
      tick: 1413, entities: [], economy: {},
      audioEvents: [
        { type: 'fire', turretBlueprintId: 'turret.cannon', pos: { x: 0, y: 0, z: 0 } },
        {
          type: 'death', turretBlueprintId: 'unit.tank', pos: { x: 100, y: 100, z: 5 },
          deathContext: {
            unitVel: { x: 1, y: 1 },
            hitDir: { x: 1, y: 0 },
            projectileVel: { x: 30, y: 0 },
            attackMagnitude: 90,
            radius: 35,
            color: 0xFFFF00,
            unitBlueprintId: 'tank',
            rotation: 0.5,
            turretPoses: [{ rotation: 0.1, pitch: 0.05 }],
          },
        },
        {
          type: 'hit', turretBlueprintId: 'shot.rocket', pos: { x: 200, y: 200, z: 10 },
          impactContext: {
            collisionRadius: 6,
            explosionRadius: 40,
            projectile: { pos: { x: 200, y: 200 }, vel: { x: 100, y: 0 } },
            entity: { vel: { x: -5, y: 5 }, collisionRadius: 20 },
            penetrationDir: { x: 0.707, y: -0.707 },
          },
        },
        {
          type: 'death', turretBlueprintId: 'unit.commander', pos: { x: 300, y: 300, z: 0 },
          deathContext: {
            unitVel: { x: 0, y: 0 },
            hitDir: { x: -1, y: 0 },
            projectileVel: { x: -50, y: 0 },
            attackMagnitude: 200,
            radius: 50,
            color: 0x00FF00,
          },
        },
      ],
      isDelta: true,
    },
    // economy — single player.
    {
      tick: 1300, entities: [],
      economy: {
        1: {
          stockpile: { curr: 500, max: 1000 },
          income: { base: 25, production: 12 },
          expenditure: 8,
          metal: {
            stockpile: { curr: 200, max: 800 },
            income: { base: 10, extraction: 4 },
            expenditure: 6,
          },
        },
      },
      isDelta: true,
    },
    // economy — multiple players, intentionally out-of-order keys to
    // verify the helper's ASC-by-playerId sort.
    {
      tick: 1301, entities: [],
      economy: {
        3: {
          stockpile: { curr: 50, max: 200 },
          income: { base: 5, production: 0 },
          expenditure: 3,
          metal: {
            stockpile: { curr: 10, max: 200 },
            income: { base: 2, extraction: 0 },
            expenditure: 1,
          },
        },
        1: {
          stockpile: { curr: 1000, max: 1000 },
          income: { base: 30, production: 20 },
          expenditure: 15,
          metal: {
            stockpile: { curr: 800, max: 800 },
            income: { base: 15, extraction: 8 },
            expenditure: 10,
          },
        },
      },
      isDelta: false,
    },
    // sprayTargets — minimal build spray, no z / dim / radius / speed / particleRadius.
    {
      tick: 1100, entities: [], economy: {},
      sprayTargets: [{
        source: { id: 1, pos: { x: 100, y: 200 }, playerId: 1 },
        target: { id: 2, pos: { x: 300, y: 400 } },
        type: 'build',
        intensity: 0.5,
      }],
      isDelta: true,
    },
    // sprayTargets — heal type with all optional fields populated.
    {
      tick: 1101, entities: [], economy: {},
      sprayTargets: [{
        source: { id: 10, pos: { x: 0, y: 0 }, z: 5, playerId: 2 },
        target: {
          id: 20,
          pos: { x: 500, y: 600 },
          z: 10,
          dim: { x: 4, y: 6 },
          radius: 80,
        },
        type: 'heal',
        intensity: 0.85,
        speed: 12,
        particleRadius: 3,
      }],
      isDelta: true,
    },
    // sprayTargets — multiple sprays mixing types and optional combos.
    {
      tick: 1102, entities: [], economy: {},
      sprayTargets: [
        {
          source: { id: 30, pos: { x: 1000, y: 1000 }, playerId: 1 },
          target: { id: 31, pos: { x: 1100, y: 1100 }, dim: { x: 8, y: 8 } },
          type: 'build',
          intensity: 0.3,
          speed: 5,
        },
        {
          source: { id: 32, pos: { x: -200, y: 0 }, z: 12, playerId: 3 },
          target: { id: 33, pos: { x: -100, y: 50 }, radius: 25 },
          type: 'heal',
          intensity: 1.0,
          particleRadius: 2,
        },
      ],
      isDelta: true,
    },
    // shroud — small bitmap exercising bin8 path (len <= 0xFF).
    {
      tick: 1010, entities: [], economy: {}, isDelta: false,
      shroud: {
        gridW: 8, gridH: 4, cellSize: 64,
        bitmap: new Uint8Array([0x01, 0x03, 0x07, 0x0F, 0x1F, 0x3F, 0x7F, 0xFF]),
      },
    },
    // shroud — bitmap > 255 bytes pushes msgpack into bin16 territory.
    {
      tick: 1011, entities: [], economy: {}, isDelta: false,
      shroud: (() => {
        const bytes = new Uint8Array(300);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xFF;
        return { gridW: 30, gridH: 10, cellSize: 32, bitmap: bytes };
      })(),
    },
    // scanPulses + everything else (validates ordering: scanPulses
    // emits AFTER visibilityFiltered).
    {
      tick: 1002, entities: [
        {
          id: 30, type: 'unit', pos: { x: 50, y: 50, z: 0 }, rotation: 0, playerId: 1,
          unit: { hp: { curr: 100, max: 100 }, velocity: { x: 0, y: 0, z: 0 } },
        },
      ],
      minimapEntities: [
        { id: 30, pos: { x: 50, y: 50 }, type: 'unit', playerId: 1 },
      ],
      economy: {},
      gameState: { phase: 'battle' },
      isDelta: true,
      removedEntityIds: [25],
      visibilityFiltered: true,
      scanPulses: [
        { playerId: 1, x: 50, y: 50, z: 0, radius: 1200, expiresAtTick: 1066 },
      ],
    },
    // scanPulses + shroud together — both lazy-added, scanPulses
    // first, shroud second.
    {
      tick: 1003, entities: [], economy: {}, isDelta: false,
      scanPulses: [
        { playerId: 2, x: 200, y: 300, z: 10, radius: 500, expiresAtTick: 1067 },
      ],
      shroud: {
        gridW: 4, gridH: 2, cellSize: 64,
        bitmap: new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x11, 0x22]),
      },
    },
    // beamUpdates: minimal 2-vertex beam (start + end), no reflectors.
    {
      tick: 900, entities: [], economy: {},
      projectiles: {
        beamUpdates: [{
          id: 11001,
          points: [
            { x: 100, y: 200, z: 50, vx: 0, vy: 0, vz: 0 },
            { x: 1000, y: 800, z: 50, vx: 0, vy: 0, vz: 0 },
          ],
        }],
      },
      isDelta: true,
    },
    // beamUpdates: full optionals (obstructionT + endpointDamageable +
    // mid-vertex reflector with normal + reflectorPlayerId).
    {
      tick: 901, entities: [], economy: {},
      projectiles: {
        beamUpdates: [{
          id: 11002,
          points: [
            { x: 0, y: 0, z: 10, vx: 0, vy: 0, vz: 0 },
            {
              x: 500, y: 500, z: 10, vx: 1, vy: 2, vz: 0,
              reflectorEntityId: 4242,
              reflectorKind: 'forceField',
              reflectorPlayerId: 2,
              normalX: -707, normalY: 707, normalZ: 0,
            },
            { x: 1000, y: 0, z: 10, vx: -1, vy: 2, vz: 0 },
          ],
          obstructionT: 0.755,
          endpointDamageable: false,
        }],
      },
      isDelta: true,
    },
    // beamUpdates: force-field reflector kind on a beam point.
    {
      tick: 902, entities: [], economy: {},
      projectiles: {
        beamUpdates: [{
          id: 11003,
          points: [
            { x: 50, y: 50, z: 0, vx: 0, vy: 0, vz: 0 },
            {
              x: 200, y: 100, z: 0, vx: 0, vy: 0, vz: 0,
              reflectorEntityId: 7777,
              reflectorKind: 'forceField',
              reflectorPlayerId: 3,
            },
            { x: 350, y: 50, z: 0, vx: 0, vy: 0, vz: 0 },
          ],
        }],
      },
      isDelta: true,
    },
    // beamUpdates: multiple beams in one tick + mixed with all other
    // projectile sub-arrays.
    {
      tick: 903, entities: [], economy: {},
      projectiles: {
        spawns: [{
          id: 12000,
          pos: { x: 0, y: 0, z: 0 },
          rotation: 0,
          velocity: { x: 50, y: 0, z: 0 },
          projectileType: 1,
          turretBlueprintCode: 2,
          playerId: 1,
          sourceEntityId: 100,
          turretIndex: 0,
          barrelIndex: 0,
        }],
        despawns: [{ id: 12001 }],
        velocityUpdates: [
          { id: 12002, pos: { x: 50, y: 0, z: 50 }, velocity: { x: 25, y: 0, z: 0 } },
        ],
        beamUpdates: [
          {
            id: 12003,
            points: [
              { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
              { x: 500, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
            ],
          },
          {
            id: 12004,
            points: [
              { x: 0, y: 100, z: 0, vx: 0, vy: 0, vz: 0 },
              { x: 500, y: 100, z: 0, vx: 0, vy: 0, vz: 0 },
              { x: 1000, y: 100, z: 0, vx: 0, vy: 0, vz: 0 },
            ],
            obstructionT: 0.5,
          },
        ],
      },
      isDelta: true,
    },
    // Explicit false/true projectile booleans are rare in production
    // serializers but must not force raw MessagePack fallback for
    // ad-hoc/debug DTOs.
    {
      tick: 904, entities: [], economy: {},
      projectiles: {
        spawns: [{
          id: 12010,
          pos: { x: 10, y: 20, z: 30 },
          rotation: 1.25,
          velocity: { x: 0, y: 5, z: 0 },
          projectileType: 1,
          turretBlueprintCode: 2,
          playerId: 1,
          sourceEntityId: 100,
          turretIndex: 0,
          barrelIndex: 1,
          isDGun: false,
          fromParentDetonation: false,
        }],
        beamUpdates: [{
          id: 12011,
          points: [
            { x: 10, y: 10, z: 0, vx: 0, vy: 0, vz: 0 },
            { x: 50, y: 50, z: 0, vx: 0, vy: 0, vz: 0 },
          ],
          endpointDamageable: true,
        }],
      },
      isDelta: true,
    },
    // Full keyframe static terrain + buildability after the common
    // envelope tail. The small arrays preserve the real DTO field
    // order without making the dev parity fixture heavy.
    {
      tick: 1000, entities: [], economy: {},
      gameState: { phase: 'battle' },
      isDelta: false,
      terrain: {
        mapWidth: 400,
        mapHeight: 300,
        cellSize: 20,
        subdiv: 2,
        cellsX: 20,
        cellsY: 15,
        verticesX: 41,
        verticesY: 31,
        version: 7,
        meshVertexCoords: [0, 0, 20, 0, 0, 20],
        meshVertexHeights: [0, 1.5, -2],
        meshTriangleIndices: [0, 1, 2],
        meshTriangleLevels: [0],
        meshTriangleNeighborIndices: [-1, 2, 3],
        meshTriangleNeighborLevels: [-1, 1, 1],
        meshCellTriangleOffsets: [0, 1, 1],
        meshCellTriangleIndices: [0],
      },
      buildability: {
        mapWidth: 400,
        mapHeight: 300,
        cellSize: 40,
        cellsX: 10,
        cellsY: 8,
        version: 7,
        configKey: 'plateau-a',
        flags: [1, 0, 1, 1],
        levels: [0, 0, 2, 2],
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const f of fixtures) {
    const wireFixture = sparseEnvelopeFixture(f);
    const jsBytes = msgpackEncode(wireFixture, SNAPSHOT_ENCODE_OPTIONS);

    const hasMinimap = f.minimapEntities !== undefined ? 1 : 0;
    const hasSprayTargets = f.sprayTargets !== undefined ? 1 : 0;
    const hasAudioEvents = f.audioEvents !== undefined ? 1 : 0;
    const hasProjectiles = f.projectiles !== undefined ? 1 : 0;
    const hasEconomy = 1;  // always emitted in this commit
    const hasGameState = f.gameState !== undefined ? 1 : 0;
    const hasWinnerId = f.gameState?.winnerId !== undefined ? 1 : 0;
    const hasRemovedIds = f.removedEntityIds !== undefined ? 1 : 0;
    const hasVisibilityFiltered = f.visibilityFiltered !== undefined ? 1 : 0;
    const hasScanPulses = f.scanPulses !== undefined ? 1 : 0;
    const hasShroud = f.shroud !== undefined ? 1 : 0;
    const hasTerrain = f.terrain !== undefined ? 1 : 0;
    const hasBuildability = f.buildability !== undefined ? 1 : 0;
    const totalKeyCount =
      2 /* tick + entities */ +
      hasMinimap +
      hasSprayTargets +
      hasAudioEvents +
      hasProjectiles +
      hasEconomy +
      hasGameState +
      1 /* isDelta */ +
      hasRemovedIds +
      hasVisibilityFiltered +
      hasScanPulses +
      hasShroud +
      hasTerrain +
      hasBuildability;

    // Pre-pack all scratches before any kernel call. String scratch
    // collects every string needed by THIS envelope's encode (waypoint
    // types from buildings, action buildingTypes from units, gameState
    // phase).
    const envelopeStrings: string[] = [];
    if (f.gameState?.phase !== undefined) envelopeStrings.push(f.gameState.phase);
    if (hasAudioEvents && f.audioEvents) {
      for (const e of f.audioEvents) {
        envelopeStrings.push(e.turretBlueprintId);
        if (e.sourceKey !== undefined) envelopeStrings.push(e.sourceKey);
        if (e.deathContext?.unitBlueprintId !== undefined) {
          envelopeStrings.push(e.deathContext.unitBlueprintId);
        }
      }
    }
    // Building waypoints + buildingTypes are packed inside the per-entity
    // loop below — but for envelope-level strings we collect now too.
    const envelopeStringSlots = envelopeStrings.length > 0
      ? packStringsIntoScratch(memory, envelopeStrings)
      : new Map<string, number>();

    if (hasRemovedIds && f.removedEntityIds) {
      packRemovedIdsIntoScratch(memory, f.removedEntityIds);
    }
    if (hasMinimap && f.minimapEntities) {
      packMinimapIntoScratch(memory, f.minimapEntities);
    }
    if (hasAudioEvents && f.audioEvents) {
      packAudioEventsIntoScratch(memory, f.audioEvents, envelopeStringSlots);
      packDeathContextsIntoScratch(memory, f.audioEvents, envelopeStringSlots);
      packImpactContextsIntoScratch(memory, f.audioEvents);
    }
    if (hasScanPulses && f.scanPulses) {
      packScanPulsesIntoScratch(memory, f.scanPulses);
    }
    if (hasShroud && f.shroud) {
      packShroudBitmapIntoScratch(memory, f.shroud.bitmap);
    }
    if (hasSprayTargets && f.sprayTargets) {
      packSprayTargetsIntoScratch(memory, f.sprayTargets);
    }
    if (hasProjectiles && f.projectiles) {
      if (f.projectiles.spawns) {
        packProjSpawnsIntoScratch(memory, f.projectiles.spawns);
      }
      if (f.projectiles.despawns) {
        packProjDespawnsIntoScratch(memory, f.projectiles.despawns.map((d) => d.id));
      }
      if (f.projectiles.velocityUpdates) {
        packProjVelocityUpdatesIntoScratch(memory, f.projectiles.velocityUpdates);
      }
      if (f.projectiles.beamUpdates) {
        packBeamUpdatesIntoScratch(memory, f.projectiles.beamUpdates);
      }
    }
    snapshot_encode_envelope_begin(f.tick, f.entities.length, totalKeyCount);

    for (const e of f.entities) {
      if (e.type === 'unit') {
        const u = e as UnitFixture;
        const sn = u.unit.surfaceNormal;
        const or = u.unit.orientation;
        const av = u.unit.angularVelocity3;
        const ufActions = u.unit.actions;
        const turrets = u.unit.turrets;
        const build = u.unit.build;
        const stringList: string[] = [];
        if (ufActions) {
          for (const a of ufActions) {
            if (a.buildingBlueprintId !== undefined) stringList.push(a.buildingBlueprintId);
          }
        }
        const stringSlots = stringList.length > 0
          ? packStringsIntoScratch(memory, stringList)
          : new Map<string, number>();
        if (ufActions) packActionsIntoScratch(memory, ufActions, stringSlots);
        if (turrets) packTurretsIntoScratch(memory, turrets);
        const hasChanged = u.changedFields !== undefined ? 1 : 0;
        snapshot_encode_entity_unit(
          u.id, SNAPSHOT_ENTITY_TYPE_UNIT,
          u.pos.x, u.pos.y, u.pos.z,
          u.rotation, u.playerId,
          hasChanged, u.changedFields ?? 0,
          u.unit.hp.curr, u.unit.hp.max,
          u.unit.velocity.x, u.unit.velocity.y, u.unit.velocity.z,
          u.unit.unitBlueprintCode !== undefined ? 1 : 0,
          u.unit.unitBlueprintCode ?? 0,
          u.unit.radius !== undefined ? 1 : 0,
          u.unit.radius?.body ?? 0,
          u.unit.radius?.shot ?? 0,
          u.unit.radius?.push ?? 0,
          u.unit.bodyCenterHeight !== undefined ? 1 : 0,
          u.unit.bodyCenterHeight ?? 0,
          u.unit.mass !== undefined ? 1 : 0,
          u.unit.mass ?? 0,
          sn !== undefined ? 1 : 0, sn?.nx ?? 0, sn?.ny ?? 0, sn?.nz ?? 0,
          or !== undefined ? 1 : 0, or?.x ?? 0, or?.y ?? 0, or?.z ?? 0, or?.w ?? 0,
          av !== undefined ? 1 : 0, av?.x ?? 0, av?.y ?? 0, av?.z ?? 0,
          u.unit.fireEnabled === false ? 1 : 0,
          u.unit.isCommander === true ? 1 : 0,
          u.unit.buildTargetId !== undefined ? 1 : 0,
          u.unit.buildTargetId === null ? 1 : 0,
          typeof u.unit.buildTargetId === 'number' ? u.unit.buildTargetId : 0,
          ufActions !== undefined ? 1 : 0, ufActions?.length ?? 0,
          turrets !== undefined ? 1 : 0, turrets?.length ?? 0,
          build !== undefined ? 1 : 0,
          build?.complete === true ? 1 : 0,
          build?.paid.energy ?? 0,
          build?.paid.metal ?? 0,
        );
      } else {
        const b = e as BuildingFixture;
        const stringList: string[] = [];
        if (b.building.factory) {
          for (const wp of b.building.factory.waypoints) stringList.push(wp.type);
        }
        const stringSlots = stringList.length > 0
          ? packStringsIntoScratch(memory, stringList)
          : new Map<string, number>();
        const bTurrets = b.building.turrets;
        if (bTurrets) packTurretsIntoScratch(memory, bTurrets);
        const factory = b.building.factory;
        if (factory) {
          packFactoryQueueIntoScratch(memory, factory.queue);
          packWaypointsIntoScratch(memory, factory.waypoints, stringSlots);
        }
        const hasChanged = b.changedFields !== undefined ? 1 : 0;
        snapshot_encode_entity_building(
          b.id, b.pos.x, b.pos.y, b.pos.z, b.rotation, b.playerId,
          hasChanged, b.changedFields ?? 0,
          b.building.buildingBlueprintCode !== undefined ? 1 : 0,
          b.building.buildingBlueprintCode ?? 0,
          b.building.dim !== undefined ? 1 : 0,
          b.building.dim?.x ?? 0, b.building.dim?.y ?? 0,
          b.building.hp.curr, b.building.hp.max,
          b.building.build.complete ? 1 : 0,
          b.building.build.paid.energy,
          b.building.build.paid.metal,
          b.building.metalExtractionRate !== undefined ? 1 : 0,
          b.building.metalExtractionRate ?? 0,
          b.building.solar !== undefined ? 1 : 0,
          b.building.solar?.open === true ? 1 : 0,
          bTurrets !== undefined ? 1 : 0, bTurrets?.length ?? 0,
          factory !== undefined ? 1 : 0,
          factory?.queue.length ?? 0,
          factory?.progress ?? 0,
          factory?.producing === true ? 1 : 0,
          factory?.energyRate ?? 0,
          factory?.metalRate ?? 0,
          factory?.waypoints.length ?? 0,
        );
      }
    }

    // Pool insertion order: minimap → economy → projectiles → ...
    if (hasMinimap && f.minimapEntities) {
      snapshot_encode_envelope_emit_minimap(f.minimapEntities.length);
    }
    if (hasEconomy) {
      const economyPlayerCount = packEconomyIntoScratch(memory, f.economy);
      snapshot_encode_envelope_emit_economy(economyPlayerCount);
    }
    if (hasSprayTargets && f.sprayTargets) {
      snapshot_encode_envelope_emit_spray_targets(f.sprayTargets.length);
    }
    if (hasAudioEvents && f.audioEvents) {
      // The per-entity loop above overwrites the string scratch with
      // action / waypoint strings, but the audio scratch only stores
      // SLOT INDICES into the string scratch. Re-pack the same audio
      // strings here so the slot indices stored in the audio scratch
      // still point at the right bytes by the time the Rust encoder
      // reads them. packStringsIntoScratch is deterministic — same
      // input order yields the same slot assignments.
      const audioStrings: string[] = [];
      for (const e of f.audioEvents) {
        audioStrings.push(e.turretBlueprintId);
        if (e.sourceKey !== undefined) audioStrings.push(e.sourceKey);
        if (e.deathContext?.unitBlueprintId !== undefined) {
          audioStrings.push(e.deathContext.unitBlueprintId);
        }
      }
      // Re-include envelope strings so gameState.phase stays valid
      // when emit_continue runs later (continue also reads the string
      // scratch).
      if (f.gameState?.phase !== undefined) audioStrings.unshift(f.gameState.phase);
      packStringsIntoScratch(memory, audioStrings);
      snapshot_encode_envelope_emit_audio_events(f.audioEvents.length);
    }
    if (hasProjectiles && f.projectiles) {
      const spawns = f.projectiles.spawns;
      const despawns = f.projectiles.despawns;
      const vels = f.projectiles.velocityUpdates;
      const beams = f.projectiles.beamUpdates;
      snapshot_encode_envelope_emit_projectiles(
        spawns !== undefined ? 1 : 0,
        spawns?.length ?? 0,
        despawns !== undefined ? 1 : 0,
        despawns?.length ?? 0,
        vels !== undefined ? 1 : 0,
        vels?.length ?? 0,
        beams !== undefined ? 1 : 0,
        beams?.length ?? 0,
      );
    }

    // Re-pack envelope-level strings — the per-entity emit loop
    // above may have overwritten the string scratch with action /
    // waypoint-type strings. By the time _continue calls
    // write_string_from_scratch for gameState.phase, the scratch
    // must contain the right bytes for the gameState slot.
    let phaseSlot = 0;
    if (hasGameState && f.gameState !== undefined) {
      const continueStrings = [f.gameState.phase];
      const continueSlots = packStringsIntoScratch(memory, continueStrings);
      phaseSlot = continueSlots.get(f.gameState.phase) ?? 0;
    }
    snapshot_encode_envelope_continue(
      hasGameState,
      phaseSlot,
      hasWinnerId,
      f.gameState?.winnerId ?? 0,
      f.isDelta ? 1 : 0,
      hasRemovedIds,
      f.removedEntityIds?.length ?? 0,
      hasVisibilityFiltered,
      f.visibilityFiltered === true ? 1 : 0,
    );

    // scanPulses sits AFTER visibilityFiltered in iteration order
    // because _snapshotBuf adds it lazily (not in the static init);
    // see commit message for D.3j-21. shroud follows scanPulses by
    // the same lazy-add ordering.
    if (hasScanPulses && f.scanPulses) {
      snapshot_encode_envelope_emit_scan_pulses(f.scanPulses.length);
    }
    if (hasShroud && f.shroud) {
      snapshot_encode_envelope_emit_shroud(
        f.shroud.gridW, f.shroud.gridH, f.shroud.cellSize, f.shroud.bitmap.length,
      );
    }
    if (hasTerrain && f.terrain) {
      emitTerrainFixture(memory, f.terrain);
    }
    if (hasBuildability && f.buildability) {
      emitBuildabilityFixture(memory, f.buildability);
    }
    const ptr = messagepack_writer_ptr();
    const len = messagepack_writer_len();
    const rustBytes = new Uint8Array(memory.buffer, ptr, len).slice();
    if (bytesEqual(jsBytes, rustBytes)) {
      passed++;
    } else {
      failed++;
      console.error(
        `[snapshot encoder] envelope byte mismatch tick=${f.tick}`,
        {
          fixture: f,
          jsLen: jsBytes.length,
          rustLen: rustBytes.length,
          jsHex: hex(jsBytes),
          rustHex: hex(rustBytes),
        },
      );
    }
  }
  return { passed, failed };
}

function runPackedMinimapCases(memory: WebAssembly.Memory): { passed: number; failed: number } {
  const fixtures: { tick: number; label: string; minimapEntities: MinimapEntityFixture[] }[] = [
    { tick: 10, label: 'empty minimap', minimapEntities: [] },
    {
      tick: 11,
      label: 'single full-vision unit',
      minimapEntities: [
        { id: 1, pos: { x: 100, y: 200 }, type: 'unit', playerId: 1 },
      ],
    },
    {
      tick: 12,
      label: 'mixed grouped contacts',
      minimapEntities: [
        { id: 3, pos: { x: 100, y: 200 }, type: 'unit', playerId: 1 },
        { id: 7, pos: { x: 120, y: 210 }, type: 'unit', playerId: 1 },
        { id: 9, pos: { x: -30, y: 40 }, type: 'building', playerId: 2 },
        { id: 12, pos: { x: 400, y: -120 }, type: 'unit', playerId: 2, radarOnly: true },
        { id: 18, pos: { x: 401, y: -122 }, type: 'unit', playerId: 2, radarOnly: true },
      ],
    },
    {
      tick: 13,
      label: 'explicit false collapses like JS V2 packer',
      minimapEntities: [
        { id: 4, pos: { x: 1, y: 2 }, type: 'unit', playerId: 1, radarOnly: false },
        { id: 5, pos: { x: 3, y: 4 }, type: 'building', playerId: 1, radarOnly: true },
      ],
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const f of fixtures) {
    const packedMinimap = packMinimapEntitiesForWire(networkMinimapFixture(f.minimapEntities));
    const wireFixture = {
      tick: f.tick,
      entities: [],
      minimapEntities: packedMinimap,
      economy: {},
      isDelta: true,
    };
    const jsBytes = msgpackEncode(wireFixture, SNAPSHOT_ENCODE_OPTIONS);
    packMinimapIntoScratch(memory, f.minimapEntities);
    snapshot_encode_envelope_begin(f.tick, 0, 5);
    snapshot_encode_envelope_emit_packed_minimap(f.minimapEntities.length);
    snapshot_encode_envelope_emit_economy(0);
    snapshot_encode_envelope_continue(0, 0, 0, 0, 1, 0, 0, 0, 0);

    const ptr = messagepack_writer_ptr();
    const len = messagepack_writer_len();
    const rustBytes = new Uint8Array(memory.buffer, ptr, len).slice();
    if (bytesEqual(jsBytes, rustBytes)) {
      passed++;
    } else {
      failed++;
      console.error(
        `[snapshot encoder] packed minimap byte mismatch ${f.label}`,
        {
          fixture: f,
          jsLen: jsBytes.length,
          rustLen: rustBytes.length,
          jsHex: hex(jsBytes),
          rustHex: hex(rustBytes),
        },
      );
    }
  }
  return { passed, failed };
}

function packProjectilesFixtureIntoScratch(
  memory: WebAssembly.Memory,
  projectiles: ProjectilesFixture,
): number {
  if (projectiles.spawns !== undefined) {
    packProjSpawnsIntoScratch(memory, projectiles.spawns);
  }
  if (projectiles.despawns !== undefined) {
    packProjDespawnsIntoScratch(memory, projectiles.despawns.map((d) => d.id));
  }
  if (projectiles.velocityUpdates !== undefined) {
    packProjVelocityUpdatesIntoScratch(memory, projectiles.velocityUpdates);
  }
  if (projectiles.beamUpdates !== undefined) {
    return packBeamUpdatesIntoScratch(memory, projectiles.beamUpdates);
  }
  return 0;
}

function runPackedProjectileCases(memory: WebAssembly.Memory): { passed: number; failed: number } {
  const fixtures: { tick: number; label: string; projectiles: ProjectilesFixture }[] = [
    {
      tick: 1800,
      label: 'v-only',
      projectiles: {},
    },
    {
      tick: 1801,
      label: 'empty-sections',
      projectiles: {
        spawns: [],
        despawns: [],
        velocityUpdates: [],
        beamUpdates: [],
      },
    },
    {
      tick: 1802,
      label: 'spawn-groups',
      projectiles: {
        spawns: [
          {
            id: 100,
            pos: { x: 10, y: 20, z: 30 },
            rotation: 4,
            velocity: { x: 5, y: 6, z: 7 },
            projectileType: 1,
            turretBlueprintCode: 2,
            playerId: 1,
            sourceEntityId: 500,
            turretIndex: 0,
            barrelIndex: 1,
          },
          {
            id: 105,
            pos: { x: -10, y: 40, z: 70 },
            rotation: -8,
            velocity: { x: -5, y: 3, z: 1 },
            projectileType: 3,
            maxLifespan: 2500,
            turretBlueprintCode: 4,
            shotBlueprintCode: 6,
            sourceTurretBlueprintCode: 7,
            sourceTurretEntityId: 77,
            playerId: 2,
            sourceEntityId: 501,
            sourceHostEntityId: 501,
            sourceRootEntityId: 500,
            sourceTeamId: 2,
            spawnTick: 1801,
            parentShotEntityId: 99,
            turretIndex: 1,
            barrelIndex: 0,
            isDGun: false,
            fromParentDetonation: true,
            beam: {
              start: { x: 0, y: 0, z: 10 },
              end: { x: 200, y: 300, z: 10 },
            },
            targetEntityId: 700,
            homingTurnRate: 9,
          },
        ],
      },
    },
    {
      tick: 1803,
      label: 'despawns-and-velocity-groups',
      projectiles: {
        despawns: [{ id: 1000 }, { id: 1005 }, { id: 1001 }],
        velocityUpdates: [
          { id: 2000, pos: { x: 1, y: 2, z: 3 }, velocity: { x: 4, y: 5, z: 6 } },
          {
            id: 2004,
            pos: { x: -1, y: -2, z: -3 },
            velocity: { x: -4, y: -5, z: -6 },
            clearHomingTarget: true,
          },
          { id: 2005, pos: { x: 7, y: 8, z: 9 }, velocity: { x: 10, y: 11, z: 12 } },
        ],
      },
    },
    {
      tick: 1804,
      label: 'beam-options',
      projectiles: {
        beamUpdates: [
          {
            id: 3000,
            points: [
              { x: 0, y: 0, z: 10, vx: 1, vy: 0, vz: 0 },
              {
                x: 100, y: 50, z: 10, vx: 0, vy: 1, vz: 0,
                reflectorEntityId: 77,
                reflectorKind: 'forceField',
                reflectorPlayerId: 3,
                normalX: -707,
                normalY: 707,
                normalZ: 0,
              },
              { x: 200, y: 0, z: 10, vx: -1, vy: 0, vz: 0 },
            ],
            obstructionT: 640,
            endpointDamageable: false,
          },
          {
            id: 3010,
            points: [
              { x: 5, y: 5, z: 0, vx: 0, vy: 0, vz: 0 },
              { x: 10, y: 10, z: 0, vx: 0, vy: 0, vz: 0 },
            ],
            endpointDamageable: true,
          },
        ],
      },
    },
    {
      tick: 1805,
      label: 'all-sections',
      projectiles: {
        spawns: [{
          id: 4000,
          pos: { x: 0, y: 0, z: 0 },
          rotation: 0,
          velocity: { x: 1, y: 2, z: 3 },
          projectileType: 2,
          turretBlueprintCode: 5,
          playerId: 1,
          sourceEntityId: 20,
          turretIndex: 0,
          barrelIndex: 0,
          isDGun: true,
        }],
        despawns: [{ id: 3990 }],
        velocityUpdates: [
          { id: 4001, pos: { x: 50, y: 60, z: 70 }, velocity: { x: 8, y: 9, z: 10 } },
        ],
        beamUpdates: [{
          id: 4002,
          points: [
            { x: 1, y: 2, z: 3, vx: 0, vy: 0, vz: 0 },
            {
              x: 4, y: 5, z: 6, vx: 0, vy: 0, vz: 0,
              reflectorEntityId: 12,
              reflectorKind: 'forceField',
            },
          ],
        }],
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const f of fixtures) {
    const packedProjectiles = packProjectilesForWire(networkProjectilesFixture(f.projectiles));
    const wireFixture = {
      tick: f.tick,
      entities: [],
      economy: {},
      projectiles: packedProjectiles,
      isDelta: true,
    };
    const jsBytes = msgpackEncode(wireFixture, SNAPSHOT_ENCODE_OPTIONS);
    const beamPointCount = packProjectilesFixtureIntoScratch(memory, f.projectiles);
    snapshot_encode_envelope_begin(f.tick, 0, 5);
    snapshot_encode_envelope_emit_economy(0);
    snapshot_encode_envelope_emit_packed_projectiles(
      f.projectiles.spawns !== undefined ? 1 : 0,
      f.projectiles.spawns?.length ?? 0,
      f.projectiles.despawns !== undefined ? 1 : 0,
      f.projectiles.despawns?.length ?? 0,
      f.projectiles.velocityUpdates !== undefined ? 1 : 0,
      f.projectiles.velocityUpdates?.length ?? 0,
      f.projectiles.beamUpdates !== undefined ? 1 : 0,
      f.projectiles.beamUpdates?.length ?? 0,
      beamPointCount,
    );
    snapshot_encode_envelope_continue(0, 0, 0, 0, 1, 0, 0, 0, 0);

    const ptr = messagepack_writer_ptr();
    const len = messagepack_writer_len();
    const rustBytes = new Uint8Array(memory.buffer, ptr, len).slice();
    if (bytesEqual(jsBytes, rustBytes)) {
      passed++;
    } else {
      failed++;
      console.error(
        `[snapshot encoder] packed projectile byte mismatch ${f.label}`,
        {
          fixture: f,
          jsLen: jsBytes.length,
          rustLen: rustBytes.length,
          jsHex: hex(jsBytes),
          rustHex: hex(rustBytes),
        },
      );
    }
  }
  return { passed, failed };
}

function runPackedStaticCases(memory: WebAssembly.Memory): { passed: number; failed: number } {
  const fixtures: {
    tick: number;
    label: string;
    terrain: TerrainFixture;
    buildability: BuildabilityFixture;
  }[] = [
    {
      tick: 1900,
      label: 'small static map',
      terrain: {
        mapWidth: 400,
        mapHeight: 300,
        cellSize: 20,
        subdiv: 2,
        cellsX: 20,
        cellsY: 15,
        verticesX: 41,
        verticesY: 31,
        version: 7,
        meshVertexCoords: [0, 0, 20, 0, 0, 20, 20, 20],
        meshVertexHeights: [0, 1.5, -2, 3.25],
        meshTriangleIndices: [0, 1, 2, 1, 3, 2],
        meshTriangleLevels: [],
        meshTriangleNeighborIndices: [],
        meshTriangleNeighborLevels: [],
        meshCellTriangleOffsets: [],
        meshCellTriangleIndices: [],
      },
      buildability: {
        mapWidth: 400,
        mapHeight: 300,
        cellSize: 40,
        cellsX: 10,
        cellsY: 8,
        version: 7,
        configKey: 'plateau-a',
        flags: [1, 1, 0, 0, 0, 2],
        levels: [0, 0, 0, 0, 1, 1],
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const f of fixtures) {
    const wireFixture = {
      tick: f.tick,
      entities: [],
      economy: {},
      terrain: packTerrainForWire(f.terrain),
      buildability: packBuildabilityForWire(f.buildability),
      isDelta: false,
    };
    const jsBytes = msgpackEncode(wireFixture, SNAPSHOT_ENCODE_OPTIONS);
    snapshot_encode_envelope_begin(f.tick, 0, 6);
    snapshot_encode_envelope_emit_economy(0);
    emitPackedTerrainFixture(memory, f.terrain);
    emitPackedBuildabilityFixture(memory, f.buildability);
    snapshot_encode_envelope_continue(0, 0, 0, 0, 0, 0, 0, 0, 0);

    const ptr = messagepack_writer_ptr();
    const len = messagepack_writer_len();
    const rustBytes = new Uint8Array(memory.buffer, ptr, len).slice();
    if (bytesEqual(jsBytes, rustBytes)) {
      passed++;
    } else {
      failed++;
      console.error(
        `[snapshot encoder] packed static byte mismatch ${f.label}`,
        {
          fixture: f,
          jsLen: jsBytes.length,
          rustLen: rustBytes.length,
          jsHex: hex(jsBytes),
          rustHex: hex(rustBytes),
        },
      );
    }
  }
  return { passed, failed };
}

export async function runSnapshotEncoderByteEqualityTest(
  memory: WebAssembly.Memory,
): Promise<void> {
  console.log('[snapshot encoder] running D.3j byte-equality fixtures…');
  const basic = runEntityBasicCases(memory);
  const unit = runEntityUnitCases(memory);
  const building = runEntityBuildingCases(memory);
  const envelope = runEnvelopeCases(memory);
  const packedMinimap = runPackedMinimapCases(memory);
  const packedProjectiles = runPackedProjectileCases(memory);
  const packedStatic = runPackedStaticCases(memory);
  const passed =
    basic.passed +
    unit.passed +
    building.passed +
    envelope.passed +
    packedMinimap.passed +
    packedProjectiles.passed +
    packedStatic.passed;
  const failed =
    basic.failed +
    unit.failed +
    building.failed +
    envelope.failed +
    packedMinimap.failed +
    packedProjectiles.failed +
    packedStatic.failed;
  const total = passed + failed;
  if (failed > 0) {
    throw new Error(
      `[snapshot encoder] FAILED ${failed}/${total} byte-equality fixtures. ` +
      `Per-fixture hex diff was console.error'd above; building more encoder ` +
      `kernels on a broken foundation is pointless. Fix the divergence first ` +
      `(usually a missing int-encoding branch in the D.2 writer) or revert.`,
    );
  }
  console.info(
    `[snapshot encoder] D.3j byte-equality: ${passed}/${total} fixtures passed.`,
  );
}

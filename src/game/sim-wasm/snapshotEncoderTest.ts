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
import { SNAPSHOT_ENTITY_TYPE_UNIT, SNAPSHOT_ENTITY_TYPE_BUILDING } from './init';

const TURRET_SCRATCH_STRIDE = 12;
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
    id: number;
    angular: {
      rot: number; vel: number; acc: number;
      pitch: number; pitchVel: number; pitchAcc: number;
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
  buildingType?: string;
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
    const jsBytes = msgpackEncode(f, SNAPSHOT_ENCODE_OPTIONS);
    const typeTag = f.type === 'unit' ? SNAPSHOT_ENTITY_TYPE_UNIT : SNAPSHOT_ENTITY_TYPE_BUILDING;
    const hasChanged = f.changedFields !== undefined ? 1 : 0;
    const changed = f.changedFields ?? 0;
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
    movementAccel?: { x: number; y: number; z: number };
    surfaceNormal?: { nx: number; ny: number; nz: number };
    suspension?: {
      offset: { x: number; y: number; z: number };
      velocity: { x: number; y: number; z: number };
      legContact?: true;
    };
    jump?: {
      enabled: boolean;
      active?: true;
      launchSeq?: number;
    };
    orientation?: { x: number; y: number; z: number; w: number };
    angularVelocity3?: { x: number; y: number; z: number };
    angularAcceleration3?: { x: number; y: number; z: number };
    fireEnabled?: false;
    isCommander?: true;
    buildTargetId?: number | null;
    actions?: ActionFixture[];
    turrets?: TurretFixture[];
    build?: {
      complete: boolean;
      paid: { energy: number; mana: number; metal: number };
    };
  };
};

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
    view[base + 9] = a.buildingType !== undefined ? 1 : 0;
    view[base + 10] = a.buildingType !== undefined ? (stringSlots.get(a.buildingType) ?? 0) : 0;
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
    view[base + 2] = t.turret.angular.acc;
    view[base + 3] = t.turret.angular.pitch;
    view[base + 4] = t.turret.angular.pitchVel;
    view[base + 5] = t.turret.angular.pitchAcc;
    view[base + 6] = t.turret.id;
    view[base + 7] = t.state;
    view[base + 8] = t.targetId !== undefined ? 1 : 0;
    view[base + 9] = t.targetId ?? 0;
    view[base + 10] = t.currentForceFieldRange !== undefined ? 1 : 0;
    view[base + 11] = t.currentForceFieldRange ?? 0;
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
    // movementAccel only (e.g. a unit accelerating from rest on flat ground)
    {
      id: 2, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        movementAccel: { x: 50, y: 0, z: 0 },
      },
    },
    // movementAccel + surfaceNormal together (cruising up a slope)
    {
      id: 33, type: 'unit', pos: { x: 5000, y: 5000, z: 200 }, rotation: 1571, playerId: 2,
      unit: {
        hp: { curr: 88, max: 120 },
        velocity: { x: 100, y: 50, z: 5 },
        movementAccel: { x: 80, y: 40, z: 0 },
        surfaceNormal: { nx: 100, ny: 100, nz: 985 },
      },
    },
    // movementAccel with delta path + negative components
    {
      id: 511, type: 'unit', pos: { x: 1, y: 2, z: 3 }, rotation: -100, playerId: 3, changedFields: 0x404,
      unit: {
        hp: { curr: 200, max: 200 },
        velocity: { x: -200, y: 0, z: 0 },
        movementAccel: { x: -150, y: -100, z: 0 },
      },
    },
    // suspension without legContact (legged walker airborne mid-step)
    {
      id: 110, type: 'unit', pos: { x: 0, y: 0, z: 50 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: -10 },
        suspension: {
          offset: { x: 0, y: 0, z: 200 },
          velocity: { x: 0, y: 0, z: -50 },
        },
      },
    },
    // suspension with legContact (grounded, settled)
    {
      id: 220, type: 'unit', pos: { x: 100, y: 200, z: 30 }, rotation: 314, playerId: 2,
      unit: {
        hp: { curr: 88, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        suspension: {
          offset: { x: 5, y: -3, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          legContact: true,
        },
      },
    },
    // suspension + movementAccel + surfaceNormal (mid-stride on slope)
    {
      id: 330, type: 'unit', pos: { x: 5000, y: 5000, z: 200 }, rotation: 1571, playerId: 2, changedFields: 0x204,
      unit: {
        hp: { curr: 75, max: 120 },
        velocity: { x: 50, y: 25, z: 3 },
        movementAccel: { x: 40, y: 20, z: 0 },
        surfaceNormal: { nx: 100, ny: 100, nz: 985 },
        suspension: {
          offset: { x: -10, y: 5, z: 100 },
          velocity: { x: 0, y: 0, z: 20 },
          legContact: true,
        },
      },
    },
    // jump enabled=false, no active, no launchSeq (idle jumper)
    {
      id: 410, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        jump: { enabled: false },
      },
    },
    // jump enabled=true, no active, no launchSeq (armed but pre-launch)
    {
      id: 411, type: 'unit', pos: { x: 100, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        jump: { enabled: true },
      },
    },
    // jump enabled=true, active=true, launchSeq (mid-flight after launch)
    {
      id: 412, type: 'unit', pos: { x: 200, y: 0, z: 500 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 90, max: 100 },
        velocity: { x: 50, y: 0, z: 100 },
        jump: { enabled: true, active: true, launchSeq: 42 },
      },
    },
    // jump with launchSeq only (no active) + delta path
    {
      id: 413, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2, changedFields: 0x800,
      unit: {
        hp: { curr: 50, max: 50 },
        velocity: { x: 0, y: 0, z: 0 },
        jump: { enabled: true, launchSeq: 9999 },
      },
    },
    // Everything together — jumping unit on a slope
    {
      id: 414, type: 'unit', pos: { x: 1000, y: 2000, z: 300 }, rotation: -1571, playerId: 3, changedFields: 0x80F,
      unit: {
        hp: { curr: 60, max: 100 },
        velocity: { x: 75, y: -25, z: 200 },
        movementAccel: { x: 50, y: 0, z: 0 },
        surfaceNormal: { nx: 50, ny: -100, nz: 990 },
        suspension: {
          offset: { x: 0, y: 0, z: 150 },
          velocity: { x: 0, y: 0, z: 50 },
          legContact: true,
        },
        jump: { enabled: true, active: true, launchSeq: 123 },
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
    // ACC-client hover unit: full triad (banking into a turn)
    {
      id: 512, type: 'unit', pos: { x: 500, y: 500, z: 800 }, rotation: 1571, playerId: 3, changedFields: 0x4,
      unit: {
        hp: { curr: 75, max: 100 },
        velocity: { x: 200, y: 100, z: 10 },
        orientation: { x: -100, y: 0, z: 707, w: 700 },
        angularVelocity3: { x: 0, y: -30, z: 100 },
        angularAcceleration3: { x: 0, y: 0, z: 50 },
      },
    },
    // Negative quaternion components + negative angular vectors
    {
      id: 513, type: 'unit', pos: { x: -100, y: -200, z: 600 }, rotation: -1571, playerId: 1,
      unit: {
        hp: { curr: 40, max: 100 },
        velocity: { x: -50, y: -100, z: -20 },
        orientation: { x: -174, y: -342, z: -924, w: 1 },
        angularVelocity3: { x: -25, y: -50, z: -75 },
        angularAcceleration3: { x: -10, y: -20, z: -30 },
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
        fireEnabled: false,
        isCommander: true,
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
              id: 5,
              angular: { rot: 0, vel: 0, acc: 0, pitch: 0, pitchVel: 0, pitchAcc: 0 },
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
              id: 12,
              angular: { rot: 1.235, vel: 0.5, acc: -0.1, pitch: 0.3, pitchVel: 0.05, pitchAcc: 0 },
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
              id: 33,
              angular: { rot: 0, vel: 0, acc: 0, pitch: 1.571, pitchVel: 0, pitchAcc: 0 },
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
            turret: { id: 1, angular: { rot: 0, vel: 0, acc: 0, pitch: 0, pitchVel: 0, pitchAcc: 0 } },
            state: 0,
          },
          {
            turret: { id: 2, angular: { rot: 1.5, vel: 0.1, acc: 0, pitch: 0.2, pitchVel: 0, pitchAcc: 0 } },
            targetId: 999,
            state: 2,
          },
          {
            turret: { id: 3, angular: { rot: -0.5, vel: 0, acc: 0, pitch: 0, pitchVel: 0, pitchAcc: 0 } },
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
          turret: { id: i, angular: { rot: i * 0.1, vel: 0, acc: 0, pitch: 0, pitchVel: 0, pitchAcc: 0 } },
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
    // Build action with grid + buildingId (no buildingType — string not supported yet)
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
              id: 7,
              angular: { rot: 1.5, vel: 0.2, acc: 0, pitch: 0.1, pitchVel: 0, pitchAcc: 0 },
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
          paid: { energy: 25, mana: 0, metal: 15 },
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
          paid: { energy: 100, mana: 50, metal: 200 },
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
          paid: { energy: 33.3, mana: 11.1, metal: 55.5 },
        },
      },
    },
    // Build action with buildingType string
    {
      id: 1000, type: 'unit', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      unit: {
        hp: { curr: 100, max: 100 },
        velocity: { x: 0, y: 0, z: 0 },
        actions: [
          { type: 7, buildingType: 'factory', grid: { x: 10, y: 20 } },
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
          { type: 7, buildingType: 'pylon', grid: { x: 0, y: 0 } },
          { type: 7, buildingType: 'pylon', grid: { x: 5, y: 5 } },
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
          { type: 7, buildingType: 'commandCenter', grid: { x: 0, y: 0 } },
          { type: 7, buildingType: 'energyConverter', grid: { x: 10, y: 0 } },
          { type: 7, buildingType: 'extractor', grid: { x: 20, y: 0 } },
        ],
      },
    },
    // buildingType with full action (everything optional present)
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
            buildingType: 'turret_defender',
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
    const jsBytes = msgpackEncode(f, SNAPSHOT_ENCODE_OPTIONS);
    const typeTag = f.type === 'unit' ? SNAPSHOT_ENTITY_TYPE_UNIT : SNAPSHOT_ENTITY_TYPE_BUILDING;
    const hasChanged = f.changedFields !== undefined ? 1 : 0;
    const changed = f.changedFields ?? 0;
    const ma = f.unit.movementAccel;
    const hasMovementAccel = ma !== undefined ? 1 : 0;
    const sn = f.unit.surfaceNormal;
    const hasNormal = sn !== undefined ? 1 : 0;
    const sp = f.unit.suspension;
    const hasSuspension = sp !== undefined ? 1 : 0;
    const jp = f.unit.jump;
    const hasJump = jp !== undefined ? 1 : 0;
    const or = f.unit.orientation;
    const hasOrientation = or !== undefined ? 1 : 0;
    const av = f.unit.angularVelocity3;
    const hasAngularVelocity3 = av !== undefined ? 1 : 0;
    const aa = f.unit.angularAcceleration3;
    const hasAngularAcceleration3 = aa !== undefined ? 1 : 0;
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
        if (a.buildingType !== undefined) strings.push(a.buildingType);
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
    const buildPaidMana = build?.paid.mana ?? 0;
    const buildPaidMetal = build?.paid.metal ?? 0;
    snapshot_encode_entity_unit(
      f.id, typeTag,
      f.pos.x, f.pos.y, f.pos.z,
      f.rotation, f.playerId,
      hasChanged, changed,
      f.unit.hp.curr, f.unit.hp.max,
      f.unit.velocity.x, f.unit.velocity.y, f.unit.velocity.z,
      hasMovementAccel,
      ma?.x ?? 0, ma?.y ?? 0, ma?.z ?? 0,
      hasNormal,
      sn?.nx ?? 0, sn?.ny ?? 0, sn?.nz ?? 0,
      hasSuspension,
      sp?.offset.x ?? 0, sp?.offset.y ?? 0, sp?.offset.z ?? 0,
      sp?.velocity.x ?? 0, sp?.velocity.y ?? 0, sp?.velocity.z ?? 0,
      sp?.legContact === true ? 1 : 0,
      hasJump,
      jp?.enabled === true ? 1 : 0,
      jp?.active === true ? 1 : 0,
      jp?.launchSeq !== undefined ? 1 : 0,
      jp?.launchSeq ?? 0,
      hasOrientation,
      or?.x ?? 0, or?.y ?? 0, or?.z ?? 0, or?.w ?? 0,
      hasAngularVelocity3,
      av?.x ?? 0, av?.y ?? 0, av?.z ?? 0,
      hasAngularAcceleration3,
      aa?.x ?? 0, aa?.y ?? 0, aa?.z ?? 0,
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
      buildPaidMana,
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
  manaRate: number;
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
    type?: string;
    dim?: { x: number; y: number };
    hp: { curr: number; max: number };
    build: {
      complete: boolean;
      paid: { energy: number; mana: number; metal: number };
    };
    metalExtractionRate?: number;
    solar?: { open: boolean };
    turrets?: TurretFixture[];
    factory?: FactoryFixture;
  };
};

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
        build: { complete: true, paid: { energy: 100, mana: 0, metal: 50 } },
      },
    },
    // Full record: type + dim + hp + build
    {
      id: 2001, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        type: 'factory',
        dim: { x: 8, y: 8 },
        hp: { curr: 1000, max: 1000 },
        build: { complete: true, paid: { energy: 500, mana: 0, metal: 200 } },
      },
    },
    // Under-construction shell (incomplete build)
    {
      id: 2002, type: 'building', pos: { x: 200, y: 300, z: 50 }, rotation: 0, playerId: 2,
      building: {
        type: 'pylon',
        dim: { x: 4, y: 4 },
        hp: { curr: 30, max: 300 },
        build: { complete: false, paid: { energy: 25, mana: 0, metal: 10 } },
      },
    },
    // Extractor (has metalExtractionRate)
    {
      id: 2003, type: 'building', pos: { x: 100, y: 100, z: 0 }, rotation: 0, playerId: 1,
      building: {
        type: 'extractor',
        dim: { x: 4, y: 4 },
        hp: { curr: 200, max: 200 },
        build: { complete: true, paid: { energy: 50, mana: 0, metal: 100 } },
        metalExtractionRate: 12.5,
      },
    },
    // Solar panel (has solar.open)
    {
      id: 2004, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        type: 'solar',
        dim: { x: 4, y: 4 },
        hp: { curr: 150, max: 150 },
        build: { complete: true, paid: { energy: 0, mana: 0, metal: 80 } },
        solar: { open: true },
      },
    },
    // Solar closed (panel folded for protection)
    {
      id: 2005, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        hp: { curr: 150, max: 150 },
        build: { complete: true, paid: { energy: 0, mana: 0, metal: 80 } },
        solar: { open: false },
      },
    },
    // Defense turret (has turrets array)
    {
      id: 2006, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 2,
      building: {
        type: 'turretDefender',
        dim: { x: 2, y: 2 },
        hp: { curr: 400, max: 400 },
        build: { complete: true, paid: { energy: 100, mana: 0, metal: 100 } },
        turrets: [
          {
            turret: {
              id: 9,
              angular: { rot: 1.5, vel: 0.2, acc: 0, pitch: 0.5, pitchVel: 0, pitchAcc: 0 },
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
        build: { complete: true, paid: { energy: 500, mana: 0, metal: 200 } },
      },
    },
    // Everything together — full record with all optional fields populated
    {
      id: 2008, type: 'building', pos: { x: 5000, y: 5000, z: 100 }, rotation: 0, playerId: 1,
      building: {
        type: 'fortifiedExtractor',
        dim: { x: 6, y: 6 },
        hp: { curr: 880, max: 1000 },
        build: { complete: true, paid: { energy: 200, mana: 50, metal: 300 } },
        metalExtractionRate: 25,
        solar: { open: true },
        turrets: [
          {
            turret: { id: 1, angular: { rot: 0, vel: 0, acc: 0, pitch: 0, pitchVel: 0, pitchAcc: 0 } },
            state: 0,
          },
        ],
      },
    },
    // Idle factory (empty queue, default rally point only)
    {
      id: 2100, type: 'building', pos: { x: 0, y: 0, z: 0 }, rotation: 0, playerId: 1,
      building: {
        type: 'factory',
        dim: { x: 8, y: 8 },
        hp: { curr: 1000, max: 1000 },
        build: { complete: true, paid: { energy: 500, mana: 0, metal: 200 } },
        factory: {
          queue: [],
          progress: 0,
          producing: false,
          energyRate: 0,
          manaRate: 0,
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
        build: { complete: true, paid: { energy: 500, mana: 0, metal: 200 } },
        factory: {
          queue: [3, 7, 12],
          progress: 0.42,
          producing: true,
          energyRate: 0.85,
          manaRate: 0,
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
        build: { complete: true, paid: { energy: 500, mana: 0, metal: 200 } },
        factory: {
          queue: [1],
          progress: 0.05,
          producing: true,
          energyRate: 0.3,
          manaRate: 0,
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
        type: 'commandCenter',
        dim: { x: 10, y: 10 },
        hp: { curr: 5000, max: 5000 },
        build: { complete: true, paid: { energy: 0, mana: 0, metal: 0 } },
        factory: {
          queue: [99, 100, 101, 102],
          progress: 0.9,
          producing: true,
          energyRate: 1.0,
          manaRate: 0.5,
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
    const jsBytes = msgpackEncode(f, SNAPSHOT_ENCODE_OPTIONS);
    const hasChanged = f.changedFields !== undefined ? 1 : 0;
    const changed = f.changedFields ?? 0;
    const stringList: string[] = [];
    if (f.building.type !== undefined) stringList.push(f.building.type);
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
    snapshot_encode_entity_building(
      f.id,
      f.pos.x, f.pos.y, f.pos.z,
      f.rotation, f.playerId,
      hasChanged, changed,
      f.building.type !== undefined ? 1 : 0,
      f.building.type !== undefined ? (stringSlots.get(f.building.type) ?? 0) : 0,
      f.building.dim !== undefined ? 1 : 0,
      f.building.dim?.x ?? 0, f.building.dim?.y ?? 0,
      f.building.hp.curr, f.building.hp.max,
      f.building.build.complete ? 1 : 0,
      f.building.build.paid.energy,
      f.building.build.paid.mana,
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
      factory?.manaRate ?? 0,
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

export async function runSnapshotEncoderByteEqualityTest(
  memory: WebAssembly.Memory,
): Promise<void> {
  console.log('[snapshot encoder] running D.3j byte-equality fixtures…');
  const basic = runEntityBasicCases(memory);
  const unit = runEntityUnitCases(memory);
  const building = runEntityBuildingCases(memory);
  const passed = basic.passed + unit.passed + building.passed;
  const failed = basic.failed + unit.failed + building.failed;
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

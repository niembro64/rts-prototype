// Phase 10 D.3j — byte-equality test runner for the Rust entity
// encoder. Runs once at initSimWasm completion in dev builds.
// Each fixture: build the JS DTO, encode via @msgpack/msgpack with
// `ignoreUndefined: true`, call the matching Rust kernel, read the
// scratch bytes, assert equality. console.error on any mismatch.

import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  snapshot_encode_entity_basic,
  snapshot_encode_entity_unit,
  messagepack_writer_ptr,
  messagepack_writer_len,
} from './pkg/rts_sim_wasm';
import { SNAPSHOT_ENTITY_TYPE_UNIT, SNAPSHOT_ENTITY_TYPE_BUILDING } from './init';

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
  };
};

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

export async function runSnapshotEncoderByteEqualityTest(
  memory: WebAssembly.Memory,
): Promise<void> {
  console.log('[snapshot encoder] running D.3j byte-equality fixtures…');
  const basic = runEntityBasicCases(memory);
  const unit = runEntityUnitCases(memory);
  const passed = basic.passed + unit.passed;
  const failed = basic.failed + unit.failed;
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

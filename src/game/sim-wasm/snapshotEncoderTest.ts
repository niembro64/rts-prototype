// Phase 10 D.3j — byte-equality test runner for the Rust entity
// encoder. Runs once at initSimWasm completion in dev builds.
// Each fixture: build the JS DTO, encode via @msgpack/msgpack with
// `ignoreUndefined: true`, call the matching Rust kernel, read the
// scratch bytes, assert equality. console.error on any mismatch.

import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  snapshot_encode_entity_basic,
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

export async function runSnapshotEncoderByteEqualityTest(
  memory: WebAssembly.Memory,
): Promise<void> {
  const basic = runEntityBasicCases(memory);
  const total = basic.passed + basic.failed;
  if (basic.failed > 0) {
    console.error(
      `[snapshot encoder] FAILED ${basic.failed}/${total} byte-equality cases. ` +
      `Run dev console to inspect the per-fixture diff above.`,
    );
    return;
  }
  console.info(
    `[snapshot encoder] D.3j byte-equality: ${basic.passed}/${total} fixtures passed.`,
  );
}

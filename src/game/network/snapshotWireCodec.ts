import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { NetworkServerSnapshot } from './NetworkTypes';
import {
  encodeNetworkSnapshotWithRustFallback,
  type RustSnapshotEncodeResult,
} from './snapshotRustWireEncoder';

// Snapshot DTOs are pooled, so optional fields stay as own properties
// assigned to `undefined`. Default msgpack encodes those as `nil`,
// which the client decodes as `null` and treats as a present value
// (e.g. `metalExtractionRate !== undefined` would fire on null).
// `ignoreUndefined: true` makes msgpack skip those keys entirely,
// matching `JSON.stringify`'s behavior.
const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;
const RUST_SNAPSHOT_WIRE_COMPARE_ENABLED = import.meta.env.DEV && isRustSnapshotWireCompareEnabled();

type RustSnapshotWireStats = {
  attempts: number;
  matches: number;
  mismatches: number;
  unavailable: number;
  rustEntities: number;
  rawEntities: number;
  rawTopLevelKeys: Record<string, number>;
};

type RustSnapshotWireDebugApi = {
  stats: () => RustSnapshotWireStats;
  reset: () => void;
};

const rustSnapshotWireStats: RustSnapshotWireStats = {
  attempts: 0,
  matches: 0,
  mismatches: 0,
  unavailable: 0,
  rustEntities: 0,
  rawEntities: 0,
  rawTopLevelKeys: {},
};

let rustUnavailableLogged = false;

declare global {
  interface Window {
    __BA_DP02_RUST_SNAPSHOT_WIRE__?: RustSnapshotWireDebugApi;
  }
}

export function encodeNetworkSnapshot(state: NetworkServerSnapshot): Uint8Array {
  const bytes = msgpackEncode(state, SNAPSHOT_ENCODE_OPTIONS);
  if (RUST_SNAPSHOT_WIRE_COMPARE_ENABLED) {
    compareRustSnapshotWire(state, bytes);
  }
  return bytes;
}

export function decodeNetworkSnapshot(raw: Uint8Array | ArrayBuffer): NetworkServerSnapshot {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return msgpackDecode(bytes) as NetworkServerSnapshot;
}

function isRustSnapshotWireCompareEnabled(): boolean {
  if (import.meta.env.VITE_BA_DP02_RUST_SNAPSHOT_WIRE === '1') return true;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('dp02rust');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function noteRustSnapshotWireResult(result: RustSnapshotEncodeResult): void {
  rustSnapshotWireStats.rustEntities += result.rustEntityCount;
  rustSnapshotWireStats.rawEntities += result.rawEntityCount;
  for (const key of result.rawTopLevelKeys) {
    rustSnapshotWireStats.rawTopLevelKeys[key] =
      (rustSnapshotWireStats.rawTopLevelKeys[key] ?? 0) + 1;
  }
}

function compareRustSnapshotWire(state: NetworkServerSnapshot, jsBytes: Uint8Array): void {
  const rustResult = encodeNetworkSnapshotWithRustFallback(state);
  if (!rustResult) {
    rustSnapshotWireStats.unavailable++;
    if (!rustUnavailableLogged) {
      rustUnavailableLogged = true;
      console.warn('[DP-02] Rust snapshot wire compare skipped: WASM encoder unavailable or DTO key order unsupported.');
    }
    return;
  }

  rustSnapshotWireStats.attempts++;
  noteRustSnapshotWireResult(rustResult);
  if (bytesEqual(jsBytes, rustResult.bytes)) {
    rustSnapshotWireStats.matches++;
    return;
  }

  rustSnapshotWireStats.mismatches++;
  if (rustSnapshotWireStats.mismatches <= 10 || rustSnapshotWireStats.mismatches % 100 === 0) {
    console.error('[DP-02] Rust snapshot wire byte mismatch', {
      tick: state.tick,
      jsBytes: jsBytes.byteLength,
      rustBytes: rustResult.bytes.byteLength,
      rustEntityCount: rustResult.rustEntityCount,
      rawEntityCount: rustResult.rawEntityCount,
      rawTopLevelKeys: rustResult.rawTopLevelKeys,
      stats: { ...rustSnapshotWireStats },
    });
  }
}

function resetRustSnapshotWireStats(): void {
  rustSnapshotWireStats.attempts = 0;
  rustSnapshotWireStats.matches = 0;
  rustSnapshotWireStats.mismatches = 0;
  rustSnapshotWireStats.unavailable = 0;
  rustSnapshotWireStats.rustEntities = 0;
  rustSnapshotWireStats.rawEntities = 0;
  rustSnapshotWireStats.rawTopLevelKeys = {};
  rustUnavailableLogged = false;
}

if (RUST_SNAPSHOT_WIRE_COMPARE_ENABLED && typeof window !== 'undefined') {
  window.__BA_DP02_RUST_SNAPSHOT_WIRE__ = {
    stats: () => ({
      ...rustSnapshotWireStats,
      rawTopLevelKeys: { ...rustSnapshotWireStats.rawTopLevelKeys },
    }),
    reset: resetRustSnapshotWireStats,
  };
}

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
const FORCE_JS_SNAPSHOT_WIRE = isForceJsSnapshotWireEnabled();

type RustSnapshotWireStats = {
  rustSends: number;
  jsSends: number;
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
  rustSends: 0,
  jsSends: 0,
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
  if (!FORCE_JS_SNAPSHOT_WIRE) {
    const rustResult = encodeNetworkSnapshotWithRustFallback(state);
    if (rustResult) {
      noteRustSnapshotWireResult(rustResult);
      if (RUST_SNAPSHOT_WIRE_COMPARE_ENABLED) {
        const jsBytes = msgpackEncode(state, SNAPSHOT_ENCODE_OPTIONS);
        if (!compareRustSnapshotWireResult(state, jsBytes, rustResult)) {
          rustSnapshotWireStats.jsSends++;
          return jsBytes;
        }
      }
      rustSnapshotWireStats.rustSends++;
      return rustResult.bytes;
    }
    noteRustSnapshotWireUnavailable();
  }

  const bytes = msgpackEncode(state, SNAPSHOT_ENCODE_OPTIONS);
  rustSnapshotWireStats.jsSends++;
  if (RUST_SNAPSHOT_WIRE_COMPARE_ENABLED && FORCE_JS_SNAPSHOT_WIRE) {
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

function isForceJsSnapshotWireEnabled(): boolean {
  const env = import.meta.env.VITE_BA_DP02_FORCE_JS_SNAPSHOT_WIRE;
  if (typeof env === 'string') {
    const normalized = env.toLowerCase();
    if (env === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
  }
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const value = params.get('dp02js');
  if (value === null) return false;
  if (value === '' || value === '1') return true;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === 'on';
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

function noteRustSnapshotWireUnavailable(): void {
  if (!RUST_SNAPSHOT_WIRE_COMPARE_ENABLED) return;
  rustSnapshotWireStats.unavailable++;
  if (!rustUnavailableLogged) {
    rustUnavailableLogged = true;
    console.warn('[DP-02] Rust snapshot wire compare skipped: WASM encoder unavailable or DTO key order unsupported.');
  }
}

function compareRustSnapshotWire(state: NetworkServerSnapshot, jsBytes: Uint8Array): void {
  const rustResult = encodeNetworkSnapshotWithRustFallback(state);
  if (!rustResult) {
    noteRustSnapshotWireUnavailable();
    return;
  }

  noteRustSnapshotWireResult(rustResult);
  compareRustSnapshotWireResult(state, jsBytes, rustResult);
}

function compareRustSnapshotWireResult(
  state: NetworkServerSnapshot,
  jsBytes: Uint8Array,
  rustResult: RustSnapshotEncodeResult,
): boolean {
  rustSnapshotWireStats.attempts++;
  if (bytesEqual(jsBytes, rustResult.bytes)) {
    rustSnapshotWireStats.matches++;
    return true;
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
  return false;
}

function resetRustSnapshotWireStats(): void {
  rustSnapshotWireStats.rustSends = 0;
  rustSnapshotWireStats.jsSends = 0;
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

import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { NetworkServerSnapshot } from './NetworkTypes';

// Snapshot DTOs are pooled, so optional fields stay as own properties
// assigned to `undefined`. Default msgpack encodes those as `nil`,
// which the client decodes as `null` and treats as a present value
// (e.g. `metalExtractionRate !== undefined` would fire on null).
// `ignoreUndefined: true` makes msgpack skip those keys entirely,
// matching `JSON.stringify`'s behavior.
const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;

export function encodeNetworkSnapshot(state: NetworkServerSnapshot): Uint8Array {
  return msgpackEncode(state, SNAPSHOT_ENCODE_OPTIONS);
}

export function decodeNetworkSnapshot(raw: Uint8Array | ArrayBuffer): NetworkServerSnapshot {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return msgpackDecode(bytes) as NetworkServerSnapshot;
}


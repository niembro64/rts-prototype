import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import type { SnapshotWirePayload } from '../network/SnapshotWirePayload';
import { encodeNetworkSnapshot } from '../network/snapshotWireCodec';

export function buildServerSnapshotWirePayload(
  state: NetworkServerSnapshot,
): SnapshotWirePayload {
  const encodeStart = performance.now();
  const bytes = encodeNetworkSnapshot(state);
  const encodeMs = performance.now() - encodeStart;
  return { bytes, encodeMs };
}

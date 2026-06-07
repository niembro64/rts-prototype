import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import type { SnapshotWirePayload } from '../network/SnapshotWirePayload';
import { encodeNetworkSnapshotDetailed } from '../network/snapshotWireCodec';

export function buildServerSnapshotWirePayload(
  state: NetworkServerSnapshot,
): SnapshotWirePayload {
  const encodeStart = performance.now();
  const encoded = encodeNetworkSnapshotDetailed(state);
  const encodeMs = performance.now() - encodeStart;
  return { ...encoded, encodeMs };
}

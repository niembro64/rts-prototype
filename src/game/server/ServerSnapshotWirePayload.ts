import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import type { SnapshotWirePayload } from '../network/SnapshotWirePayload';
import { encodeNetworkSnapshotDetailed } from '../network/snapshotWireCodec';

export type SerializedListenerSnapshot = {
  state: NetworkServerSnapshot;
  wirePayload: SnapshotWirePayload | undefined;
};

export class ServerSnapshotWirePreencoder {
  encodeIfRequested(
    state: NetworkServerSnapshot,
    preencodeWire: boolean,
  ): SerializedListenerSnapshot {
    return {
      state,
      wirePayload: preencodeWire
        ? buildServerSnapshotWirePayload(state)
        : undefined,
    };
  }

  resolve(
    snapshot: SerializedListenerSnapshot,
    preencodeWire: boolean,
  ): SnapshotWirePayload | undefined {
    if (!preencodeWire) return undefined;
    if (snapshot.wirePayload === undefined) {
      snapshot.wirePayload = buildServerSnapshotWirePayload(snapshot.state);
    }
    return snapshot.wirePayload;
  }
}

export function buildServerSnapshotWirePayload(
  state: NetworkServerSnapshot,
): SnapshotWirePayload {
  const encodeStart = performance.now();
  const encoded = encodeNetworkSnapshotDetailed(state);
  const encodeMs = performance.now() - encodeStart;
  return { ...encoded, encodeMs, materializationKind: 'dto' };
}

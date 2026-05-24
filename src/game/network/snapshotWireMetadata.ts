import type { NetworkServerSnapshot } from './NetworkTypes';

const SNAPSHOT_WIRE_BYTES = Symbol('snapshotWireBytes');

type SnapshotWireByteCarrier = NetworkServerSnapshot & {
  [SNAPSHOT_WIRE_BYTES]: number | undefined;
};

export function setSnapshotWireBytes(
  state: NetworkServerSnapshot,
  bytes: number,
): void {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  Object.defineProperty(state, SNAPSHOT_WIRE_BYTES, {
    value: bytes,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function getSnapshotWireBytes(state: NetworkServerSnapshot): number | undefined {
  const bytes = (state as SnapshotWireByteCarrier)[SNAPSHOT_WIRE_BYTES];
  return Number.isFinite(bytes) ? bytes : undefined;
}

export function clearSnapshotWireBytes(state: NetworkServerSnapshot): void {
  Object.defineProperty(state, SNAPSHOT_WIRE_BYTES, {
    value: undefined,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export function copySnapshotWireBytes(
  src: NetworkServerSnapshot,
  dst: NetworkServerSnapshot,
): void {
  const bytes = getSnapshotWireBytes(src);
  if (bytes === undefined) clearSnapshotWireBytes(dst);
  else setSnapshotWireBytes(dst, bytes);
}

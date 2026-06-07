export type SnapshotWireEncoderKind = 'rust' | 'js';
export type SnapshotWireMaterializationKind = 'dto' | 'direct';

export type SnapshotWirePayload = {
  bytes: Uint8Array;
  encodeMs: number;
  encoderKind?: SnapshotWireEncoderKind;
  materializationKind?: SnapshotWireMaterializationKind;
  rustEntityCount?: number;
  rawEntityCount?: number;
  rawTopLevelKeys?: readonly string[];
};

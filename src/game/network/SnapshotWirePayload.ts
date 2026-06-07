export type SnapshotWireEncoderKind = 'rust' | 'js';

export type SnapshotWirePayload = {
  bytes: Uint8Array;
  encodeMs: number;
  encoderKind?: SnapshotWireEncoderKind;
  rustEntityCount?: number;
  rawEntityCount?: number;
  rawTopLevelKeys?: readonly string[];
};

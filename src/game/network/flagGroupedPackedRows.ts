import {
  PACKED_BINARY_ROW_COUNT_BYTES,
  PackedBinaryWriter,
} from './snapshotBinaryWire';

/** One row group in a flag-grouped packed-rows payload: rows sharing the
 *  same wire flags are delta-encoded into a single writer so the flags
 *  are written once per group instead of once per row. */
export type FlagGroupedPackedRowGroup = {
  flags: number;
  writer: PackedBinaryWriter;
  count: number;
  lastId: number;
};

/** Get-or-create the group for `flags`, registering a new group in both
 *  the ordered `groups` list and the `groupsByFlags` lookup. */
export function getOrCreateFlagGroup(
  groups: FlagGroupedPackedRowGroup[],
  groupsByFlags: (FlagGroupedPackedRowGroup | undefined)[],
  flags: number,
  estimatedWriterBytes: number,
): FlagGroupedPackedRowGroup {
  let group = groupsByFlags[flags];
  if (group === undefined) {
    group = {
      flags,
      writer: new PackedBinaryWriter(estimatedWriterBytes),
      count: 0,
      lastId: 0,
    };
    groupsByFlags[flags] = group;
    groups.push(group);
  }
  return group;
}

/** Assemble the final payload from per-group writers: a
 *  PACKED_BINARY_ROW_COUNT_BYTES row-count header, a varuint group
 *  count, then per group a caller-written header followed by the
 *  group's row bytes. `rowCount` is the total row count stamped into
 *  the header (which may differ from the sum of group counts at some
 *  call sites). */
export function finishGroupedPackedRows<
  G extends { writer: PackedBinaryWriter },
>(
  groups: readonly G[],
  rowCount: number,
  writeGroupHeader: (out: PackedBinaryWriter, group: G) => void,
): Uint8Array {
  const chunks: Uint8Array[] = new Array(groups.length);
  let estimatedBytes = PACKED_BINARY_ROW_COUNT_BYTES + 4;
  for (let i = 0; i < groups.length; i++) {
    chunks[i] = groups[i].writer.finishBytes();
    estimatedBytes += chunks[i].byteLength + 8;
  }

  const out = new PackedBinaryWriter(estimatedBytes, PACKED_BINARY_ROW_COUNT_BYTES);
  out.writeVarUint(groups.length);
  for (let i = 0; i < groups.length; i++) {
    writeGroupHeader(out, groups[i]);
    out.writeBytes(chunks[i]);
  }
  out.setUint32LE(0, rowCount);
  return out.finishBytes();
}

function writeFlagGroupHeader(
  out: PackedBinaryWriter,
  group: FlagGroupedPackedRowGroup,
): void {
  out.writeVarUint(group.flags);
  out.writeVarUint(group.count);
}

/** Finish for the common flags+count group header. */
export function finishFlagGroupedPackedRows(
  groups: readonly FlagGroupedPackedRowGroup[],
  rowCount: number,
): Uint8Array {
  return finishGroupedPackedRows(groups, rowCount, writeFlagGroupHeader);
}

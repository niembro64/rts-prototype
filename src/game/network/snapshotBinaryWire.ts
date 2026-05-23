export const PACKED_BINARY_ROW_COUNT_BYTES = 4;

export class PackedBinaryWriter {
  protected bytes: Uint8Array;
  protected view: DataView;
  protected length: number;

  constructor(estimatedBytes: number, initialLength = 0) {
    this.bytes = new Uint8Array(Math.max(16, estimatedBytes, initialLength));
    this.view = new DataView(this.bytes.buffer);
    this.length = initialLength;
  }

  writeVarUint(value: number): void {
    let v = Math.max(0, Math.floor(value));
    while (v >= 0x80) {
      this.writeByte((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.writeByte(v);
  }

  writeVarInt(value: number): void {
    const v = Math.round(value);
    this.writeVarUint(v < 0 ? (-v * 2) - 1 : v * 2);
  }

  writeFloat64(value: number): void {
    this.ensureCapacity(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.byteLength);
    this.bytes.set(bytes, this.length);
    this.length += bytes.byteLength;
  }

  setUint32LE(offset: number, value: number): void {
    this.view.setUint32(offset, Math.max(0, Math.floor(value)), true);
  }

  finishBytes(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }

  private writeByte(value: number): void {
    this.ensureCapacity(1);
    this.bytes[this.length++] = value;
  }

  private ensureCapacity(additionalBytes: number): void {
    const needed = this.length + additionalBytes;
    if (needed <= this.bytes.length) return;

    let nextLength = this.bytes.length;
    while (nextLength < needed) nextLength *= 2;
    const next = new Uint8Array(nextLength);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
}

export class PackedBinaryReader {
  private readonly view: DataView;
  private offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    initialOffset = PACKED_BINARY_ROW_COUNT_BYTES,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = initialOffset;
  }

  get count(): number {
    return readPackedBinaryRowCount(this.bytes);
  }

  readVarUint(): number {
    let value = 0;
    let multiplier = 1;
    while (this.offset < this.bytes.byteLength) {
      const byte = this.bytes[this.offset++];
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 0x80;
    }
    return value;
  }

  readVarInt(): number {
    const value = this.readVarUint();
    return value % 2 === 0 ? value / 2 : -((value + 1) / 2);
  }

  readFloat64(): number {
    if (this.offset + 8 > this.bytes.byteLength) {
      this.offset = this.bytes.byteLength;
      return 0;
    }
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }
}

export function readPackedBinaryRowCount(rows: Uint8Array): number {
  if (rows.byteLength < PACKED_BINARY_ROW_COUNT_BYTES) return 0;
  return (
    rows[0] +
    rows[1] * 0x100 +
    rows[2] * 0x10000 +
    rows[3] * 0x1000000
  );
}

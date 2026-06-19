type WireArray = Float64Array | Uint32Array;

export type Float64WireRows = {
  values: Float64Array;
  count: number;
};

export type Uint32WireRows = {
  values: Uint32Array;
  count: number;
};

export function createFloat64WireRows(rowCapacity = 0, stride = 1): Float64WireRows {
  return {
    values: new Float64Array(Math.max(0, rowCapacity * stride)),
    count: 0,
  };
}

export function createUint32WireRows(rowCapacity = 0, stride = 1): Uint32WireRows {
  return {
    values: new Uint32Array(Math.max(0, rowCapacity * stride)),
    count: 0,
  };
}

function ensureFloat64WireRows(
  rows: Float64WireRows,
  rowCount: number,
  stride: number,
): void {
  rows.values = ensureWireRows(rows.values, rowCount, stride);
}

function ensureUint32WireRows(
  rows: Uint32WireRows,
  rowCount: number,
  stride: number,
): void {
  rows.values = ensureWireRows(rows.values, rowCount, stride);
}

export function reserveFloat64WireRows(
  rows: Float64WireRows,
  rowCount: number,
  stride: number,
): number {
  const offset = rows.count;
  ensureFloat64WireRows(rows, offset + rowCount, stride);
  rows.count += rowCount;
  return offset;
}

export function reserveUint32WireRows(
  rows: Uint32WireRows,
  rowCount: number,
  stride: number,
): number {
  const offset = rows.count;
  ensureUint32WireRows(rows, offset + rowCount, stride);
  rows.count += rowCount;
  return offset;
}

export function activeFloat64WireValues(
  rows: Float64WireRows,
  stride: number,
): Float64Array {
  return rows.values.subarray(0, rows.count * stride);
}

export function activeUint32WireValues(
  rows: Uint32WireRows,
  stride: number,
): Uint32Array {
  return rows.values.subarray(0, rows.count * stride);
}

function ensureWireRows<T extends WireArray>(
  values: T,
  rowCount: number,
  stride: number,
): T {
  const needed = rowCount * stride;
  if (needed <= values.length) return values;

  let nextRows = Math.max(4, Math.ceil(values.length / Math.max(1, stride)));
  while (nextRows < rowCount) nextRows *= 2;

  const next = new (values.constructor as { new(length: number): T })(nextRows * stride);
  next.set(values);
  return next;
}

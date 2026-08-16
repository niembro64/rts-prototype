type NumericTypedArray = {
  readonly buffer: ArrayBufferLike;
  readonly byteOffset: number;
  readonly length: number;
};

type NumericTypedArrayConstructor<T extends NumericTypedArray> = {
  new(buffer: ArrayBufferLike, byteOffset: number, length: number): T;
};

type SubarrayTypedArray<T> = NumericTypedArray & {
  subarray(begin?: number, end?: number): T;
};

/** Reuse a typed view while its buffer, pointer, and length are unchanged. */
export function reuseTypedArrayView<T extends NumericTypedArray>(
  current: T,
  buffer: ArrayBufferLike,
  byteOffset: number,
  length: number,
  Constructor: NumericTypedArrayConstructor<T>,
): T {
  if (
    current.buffer === buffer &&
    current.byteOffset === byteOffset &&
    current.length === length
  ) {
    return current;
  }
  return new Constructor(buffer, byteOffset, length);
}

/** Reuse a prefix view of a retained typed-array allocation. */
export function reuseTypedArrayPrefixView<T extends SubarrayTypedArray<T>>(
  current: T,
  source: T,
  length: number,
): T {
  if (
    current.buffer === source.buffer &&
    current.byteOffset === source.byteOffset &&
    current.length === length
  ) {
    return current;
  }
  return source.length === length ? source : source.subarray(0, length);
}

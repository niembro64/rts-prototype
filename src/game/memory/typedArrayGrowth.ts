type NumericTypedArray = ArrayLike<number> & {
  set(values: ArrayLike<number>, offset?: number): void;
};

type NumericTypedArrayConstructor<T extends NumericTypedArray> = {
  new(length: number): T;
};

/**
 * Grow a numeric typed array to an exact length while preserving its contents.
 * Growth is a cold-path operation, so selecting the constructor dynamically
 * keeps every numeric typed-array variant behind one implementation.
 */
export function growTypedArray<T extends NumericTypedArray>(
  source: T,
  nextLength: number,
): T {
  const Constructor = source.constructor as NumericTypedArrayConstructor<T>;
  const next = new Constructor(nextLength);
  next.set(source);
  return next;
}

/**
 * Grow geometrically to amortize repeated capacity increases. Returns the
 * original view when it already satisfies the requested length.
 */
export function growTypedArrayGeometrically<T extends NumericTypedArray>(
  source: T,
  requiredLength: number,
  minimumLength = 1,
): T {
  if (source.length >= requiredLength) return source;
  let nextLength = Math.max(minimumLength, source.length);
  while (nextLength < requiredLength) nextLength *= 2;
  return growTypedArray(source, nextLength);
}

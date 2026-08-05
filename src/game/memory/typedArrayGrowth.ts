type NumericTypedArray = ArrayLike<number> & {
  set(values: ArrayLike<number>, offset?: number): void;
};

type GrownTypedArrays<T extends readonly NumericTypedArray[]> = {
  -readonly [K in keyof T]: T[K];
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

/** Grow a group of parallel numeric buffers to one exact capacity. */
export function growTypedArrays<T extends readonly NumericTypedArray[]>(
  sources: T,
  nextLength: number,
): GrownTypedArrays<T> {
  const grown = new Array<NumericTypedArray>(sources.length);
  for (let i = 0; i < sources.length; i++) {
    grown[i] = growTypedArray(sources[i], nextLength);
  }
  return grown as GrownTypedArrays<T>;
}

/**
 * Doubling capacity schedule shared by every grow-on-demand buffer: start
 * from the larger of the current capacity and the configured minimum, then
 * double until the requirement fits. Callers that grow several parallel
 * arrays to one capacity use this directly.
 */
export function nextGeometricCapacity(
  currentCapacity: number,
  requiredCapacity: number,
  minimumCapacity = 1,
): number {
  let next = Math.max(minimumCapacity, currentCapacity);
  while (next < requiredCapacity) next *= 2;
  return next;
}

/** One-step doubling schedule for batches whose first reservation may be an
 * exact large hint rather than a power-of-two capacity. */
export function nextDoublingCapacity(
  currentCapacity: number,
  requiredCapacity: number,
  minimumCapacity = 1,
): number {
  return Math.max(requiredCapacity, currentCapacity * 2, minimumCapacity);
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
  return growTypedArray(
    source,
    nextGeometricCapacity(source.length, requiredLength, minimumLength),
  );
}

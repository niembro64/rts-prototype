export function definePooledScratchProperty<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V,
): asserts target is T & Record<K, V> {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: false,
    configurable: false,
  });
}

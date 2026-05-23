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

export type PooledNumberArrayScratch = {
  reset(): void;
  acquire(length: number): number[];
  release(): void;
};

export function createPooledNumberArrayScratch(): PooledNumberArrayScratch {
  const arrays: number[][] = [];
  let cursor = 0;

  return {
    reset(): void {
      cursor = 0;
    },
    acquire(length: number): number[] {
      let array = arrays[cursor];
      if (array === undefined) {
        array = [];
        arrays[cursor] = array;
      }
      cursor++;
      array.length = length;
      return array;
    },
    release(): void {
      for (let i = 0; i < cursor; i++) {
        arrays[i].length = 0;
      }
      cursor = 0;
    },
  };
}

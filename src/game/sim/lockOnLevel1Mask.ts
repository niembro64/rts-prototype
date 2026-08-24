import { CT_LOCK_ON_LEVEL1_MASK_CAPACITY } from '../sim-wasm/init';

type CompileLockOnLevel1MaskOptions = Readonly<{
  label: string;
  field: string;
  names: readonly string[];
  toCode: (name: string) => number;
  unknownCode: number;
  kindLabel: string;
}>;

function isAddressableLockOnCode(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code < CT_LOCK_ON_LEVEL1_MASK_CAPACITY;
}

export function compileLockOnLevel1Mask({
  label,
  field,
  names,
  toCode,
  unknownCode,
  kindLabel,
}: CompileLockOnLevel1MaskOptions): bigint {
  let mask = 0n;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const code = toCode(name);
    if (code === unknownCode) {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] = "${name}" has no network ${kindLabel} code`,
      );
    }
    if (!isAddressableLockOnCode(code)) {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] = "${name}" has ${kindLabel} wire code ${code} ` +
        `outside bitmask capacity ${CT_LOCK_ON_LEVEL1_MASK_CAPACITY}; widen the lockon ` +
        `level-1 masks before adding more ${kindLabel} blueprints`,
      );
    }
    mask |= 1n << BigInt(code);
  }
  return mask;
}

/** An empty named mask admits the whole already-included entity family. */
export function lockOnLevel1MaskAllows(mask: bigint, code: number): boolean {
  return mask === 0n || (
    isAddressableLockOnCode(code) &&
    (mask & (1n << BigInt(code))) !== 0n
  );
}

export function lockOnLevel1MaskFromCodes(codes: Iterable<number>): bigint {
  let mask = 0n;
  for (const code of codes) {
    if (!isAddressableLockOnCode(code)) {
      throw new Error(
        `Lock-on wire code ${code} is outside bitmask capacity ${CT_LOCK_ON_LEVEL1_MASK_CAPACITY}`,
      );
    }
    mask |= 1n << BigInt(code);
  }
  return mask;
}

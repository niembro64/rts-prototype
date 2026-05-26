const TEXT_ENCODER = new TextEncoder();
const FNV1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;

export function canonicalStringify(value: unknown): string {
  return stringifyCanonical(value);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return TEXT_ENCODER.encode(canonicalStringify(value));
}

export function canonicalHashBytes(bytes: Uint8Array): string {
  let hash = FNV1A_64_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function canonicalHashValue(value: unknown): string {
  return canonicalHashBytes(canonicalBytes(value));
}

function stringifyCanonical(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`Cannot canonicalize non-finite number: ${value}`);
      }
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new Error('Cannot canonicalize undefined');
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item) => stringifyCanonical(item)).join(',')}]`;
      }
      return stringifyCanonicalObject(value as Record<string, unknown>);
    default:
      throw new Error(`Cannot canonicalize ${typeof value}`);
  }
}

function stringifyCanonicalObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const fields: string[] = [];
  for (const key of keys) {
    const fieldValue = value[key];
    if (fieldValue === undefined) {
      throw new Error(`Cannot canonicalize undefined field "${key}"`);
    }
    fields.push(`${JSON.stringify(key)}:${stringifyCanonical(fieldValue)}`);
  }
  return `{${fields.join(',')}}`;
}

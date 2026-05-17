export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertExplicitFields(
  label: string,
  value: unknown,
  fields: readonly string[],
): asserts value is JsonObject {
  if (!isObject(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(
        `Invalid ${label}: missing explicit field "${field}"`,
      );
    }
  }
}

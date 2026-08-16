export function assertFiniteNumber(
  value: unknown,
  fieldName: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
}

export function assertFiniteNumberInRange(
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${fieldName} must be a finite number from ${minimum} through ${maximum}`,
    );
  }
}

export function assertPositiveFiniteNumber(
  value: unknown,
  fieldName: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }
}

export function assertNonNegativeFiniteNumber(
  value: unknown,
  fieldName: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number`);
  }
}

export function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
}

export function assertPositiveInteger(
  value: unknown,
  fieldName: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

export function assertSixDigitCssHex(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${fieldName} must be a six-digit CSS hex color`);
  }
}

export function assertPlainObject(
  value: unknown,
  errorMessage: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
}

export function assertExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  unexpectedKeyMessage: (key: string) => string,
  missingKeyMessage: (key: string) => string,
): void {
  const expectedKeys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) throw new Error(unexpectedKeyMessage(key));
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(missingKeyMessage(key));
    }
  }
}

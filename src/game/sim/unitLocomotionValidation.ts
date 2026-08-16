
import {
  assertBoolean,
  assertNonNegativeFiniteNumber,
} from '../../configValidation';

export function assertUnitLocomotionNonNegativeFinite(label: string, value: number): void {
  assertNonNegativeFiniteNumber(value, `Invalid unit locomotion ${label}`);
}

export function assertUnitLocomotionUnitFraction(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`Invalid unit locomotion ${label}: expected finite [0, 1), got ${value}`);
  }
}

export function assertUnitLocomotionBoolean(
  label: string,
  value: unknown,
): asserts value is boolean {
  assertBoolean(value, `Invalid unit locomotion ${label}`);
}

export function assertUnitLocomotionPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid unit locomotion ${label}: expected positive finite number, got ${value}`);
  }
}

export function assertUnitLocomotionNonNegativeFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid unit locomotion ${label}: expected finite >= 0, got ${value}`);
  }
}

export function assertUnitLocomotionUnitFraction(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`Invalid unit locomotion ${label}: expected finite [0, 1), got ${value}`);
  }
}

export function assertUnitLocomotionClosedUnitFraction(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid unit locomotion ${label}: expected finite [0, 1], got ${value}`);
  }
}

export function assertUnitLocomotionBoolean(
  label: string,
  value: unknown,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid unit locomotion ${label}: expected boolean, got ${value}`);
  }
}

export function assertUnitLocomotionSlopeDegrees(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 90) {
    throw new Error(`Invalid unit locomotion ${label}: expected finite degrees in (0, 90), got ${value}`);
  }
}

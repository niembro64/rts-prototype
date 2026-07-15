export function assertLocomotionPositiveFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid locomotion ${label}: expected positive finite number, got ${value}`);
  }
}

export function assertLocomotionNonNegativeFinite(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid locomotion ${label}: expected finite >= 0, got ${value}`);
  }
}

export function assertLocomotionUnitFraction(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`Invalid locomotion ${label}: expected finite [0, 1), got ${value}`);
  }
}

export function assertLocomotionClosedUnitFraction(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid locomotion ${label}: expected finite [0, 1], got ${value}`);
  }
}

export function assertLocomotionBoolean(
  label: string,
  value: unknown,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid locomotion ${label}: expected boolean, got ${value}`);
  }
}

export function assertLocomotionSlopeDegrees(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 90) {
    throw new Error(`Invalid locomotion ${label}: expected finite degrees in (0, 90), got ${value}`);
  }
}

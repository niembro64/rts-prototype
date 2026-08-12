import type { EmissionMediumTrajectoryMatrix } from '@/types/blueprintSchema.generated';

export type EmissionMedium = keyof EmissionMediumTrajectoryMatrix;

export const EMISSION_MEDIA = ['aboveWater', 'underwater'] as const satisfies readonly EmissionMedium[];

export const EMISSION_ROUTE_ABOVE_TO_ABOVE = 1 << 0;
export const EMISSION_ROUTE_ABOVE_TO_UNDERWATER = 1 << 1;
export const EMISSION_ROUTE_UNDERWATER_TO_ABOVE = 1 << 2;
export const EMISSION_ROUTE_UNDERWATER_TO_UNDERWATER = 1 << 3;
export const EMISSION_ROUTE_ALL =
  EMISSION_ROUTE_ABOVE_TO_ABOVE |
  EMISSION_ROUTE_ABOVE_TO_UNDERWATER |
  EMISSION_ROUTE_UNDERWATER_TO_ABOVE |
  EMISSION_ROUTE_UNDERWATER_TO_UNDERWATER;

function assertExactMediumKeys(
  label: string,
  value: unknown,
): asserts value is Record<EmissionMedium, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== EMISSION_MEDIA.length ||
    !Object.prototype.hasOwnProperty.call(record, 'aboveWater') ||
    !Object.prototype.hasOwnProperty.call(record, 'underwater')
  ) {
    throw new Error(
      `Invalid ${label}: must exhaustively define exactly aboveWater and underwater`,
    );
  }
}

/** Enforces the full W→W, W→A, A→A, A→W contract without defaults. */
export function validateEmissionMediumTrajectoryMatrix(
  label: string,
  value: unknown,
): asserts value is EmissionMediumTrajectoryMatrix {
  assertExactMediumKeys(label, value);
  for (const sourceMedium of EMISSION_MEDIA) {
    const row = value[sourceMedium];
    assertExactMediumKeys(`${label}.${sourceMedium}`, row);
    for (const targetMedium of EMISSION_MEDIA) {
      if (typeof row[targetMedium] !== 'boolean') {
        throw new Error(
          `Invalid ${label}.${sourceMedium}.${targetMedium}: expected explicit boolean`,
        );
      }
    }
  }
}

export function cloneEmissionMediumTrajectoryMatrix(
  matrix: EmissionMediumTrajectoryMatrix,
): EmissionMediumTrajectoryMatrix {
  return {
    aboveWater: { ...matrix.aboveWater },
    underwater: { ...matrix.underwater },
  };
}

export function compileEmissionMediumTrajectoryMask(
  matrix: EmissionMediumTrajectoryMatrix,
): number {
  let mask = 0;
  if (matrix.aboveWater.aboveWater) mask |= EMISSION_ROUTE_ABOVE_TO_ABOVE;
  if (matrix.aboveWater.underwater) mask |= EMISSION_ROUTE_ABOVE_TO_UNDERWATER;
  if (matrix.underwater.aboveWater) mask |= EMISSION_ROUTE_UNDERWATER_TO_ABOVE;
  if (matrix.underwater.underwater) mask |= EMISSION_ROUTE_UNDERWATER_TO_UNDERWATER;
  return mask;
}

export function emissionMediumAtZ(z: number, waterLevel: number): EmissionMedium {
  return z <= waterLevel ? 'underwater' : 'aboveWater';
}

export function emissionMediumRouteAllows(
  matrix: EmissionMediumTrajectoryMatrix,
  sourceMedium: EmissionMedium,
  targetMedium: EmissionMedium,
): boolean {
  return matrix[sourceMedium][targetMedium];
}

import {
  RAY_BLUEPRINTS,
  SHIELD_BLUEPRINTS,
  SHOT_BLUEPRINTS,
} from './blueprints';
import {
  compileEmissionMediumTrajectoryMask,
  EMISSION_ROUTE_ABOVE_TO_ABOVE,
  EMISSION_ROUTE_ABOVE_TO_UNDERWATER,
  EMISSION_ROUTE_UNDERWATER_TO_ABOVE,
  EMISSION_ROUTE_UNDERWATER_TO_UNDERWATER,
  validateEmissionMediumTrajectoryMatrix,
} from './emissionMedium';
import type { EmissionMediumTrajectoryMatrix } from '@/types/blueprintSchema.generated';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[emission medium contract] ${message}`);
}

export function runEmissionMediumContractTest(): void {
  for (const [family, blueprints] of [
    ['shot', SHOT_BLUEPRINTS],
    ['ray', RAY_BLUEPRINTS],
    ['shield', SHIELD_BLUEPRINTS],
  ] as const) {
    for (const [id, blueprint] of Object.entries(blueprints)) {
      validateEmissionMediumTrajectoryMatrix(
        `${family} blueprint ${id}.mediumTrajectory`,
        blueprint.mediumTrajectory,
      );
    }
  }

  const falseRow = { aboveWater: false, underwater: false } as const;
  const cases: readonly [string, EmissionMediumTrajectoryMatrix, number][] = [
    [
      'A->A',
      {
        aboveWater: { aboveWater: true, underwater: false },
        underwater: falseRow,
      },
      EMISSION_ROUTE_ABOVE_TO_ABOVE,
    ],
    [
      'A->W',
      {
        aboveWater: { aboveWater: false, underwater: true },
        underwater: falseRow,
      },
      EMISSION_ROUTE_ABOVE_TO_UNDERWATER,
    ],
    [
      'W->A',
      {
        aboveWater: falseRow,
        underwater: { aboveWater: true, underwater: false },
      },
      EMISSION_ROUTE_UNDERWATER_TO_ABOVE,
    ],
    [
      'W->W',
      {
        aboveWater: falseRow,
        underwater: { aboveWater: false, underwater: true },
      },
      EMISSION_ROUTE_UNDERWATER_TO_UNDERWATER,
    ],
  ];
  for (const [label, matrix, expected] of cases) {
    assertContract(
      compileEmissionMediumTrajectoryMask(matrix) === expected,
      `${label} must compile to its independent bit without implying another route`,
    );
  }
}

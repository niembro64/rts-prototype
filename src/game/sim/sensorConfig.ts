import type {
  SensorCapabilityConfig,
  SensorMediumRadiusMatrix,
  SensorMediumTargetRadii,
} from '../../types/blueprints';

export type SensorMedium = 'aboveWater' | 'underwater';

export const SENSOR_MEDIA: readonly SensorMedium[] = [
  'aboveWater',
  'underwater',
];

export const ZERO_SENSOR_TARGET_RADII: Readonly<SensorMediumTargetRadii> = {
  aboveWater: 0,
  underwater: 0,
};

function cloneTargetRadii(radii: SensorMediumTargetRadii): SensorMediumTargetRadii {
  return {
    aboveWater: radii.aboveWater,
    underwater: radii.underwater,
  };
}

function cloneRadiusMatrix(matrix: SensorMediumRadiusMatrix): SensorMediumRadiusMatrix {
  return {
    aboveWater: cloneTargetRadii(matrix.aboveWater),
    underwater: cloneTargetRadii(matrix.underwater),
  };
}

export function cloneSensorCapabilityConfig(
  sensors: SensorCapabilityConfig,
): SensorCapabilityConfig {
  return {
    fullSight: cloneRadiusMatrix(sensors.fullSight),
    contactSight: cloneRadiusMatrix(sensors.contactSight),
    detectorRadius: sensors.detectorRadius,
  };
}

function assertFiniteNonNegativeRadius(context: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a finite non-negative number`);
  }
}

export function validateSensorCapabilityConfig(
  context: string,
  sensors: SensorCapabilityConfig,
): void {
  if (!sensors || typeof sensors !== 'object') {
    throw new Error(`Invalid ${context}: sensors must be an object`);
  }
  for (const tier of ['fullSight', 'contactSight'] as const) {
    const matrix = sensors[tier];
    if (!matrix || typeof matrix !== 'object') {
      throw new Error(`Invalid ${context}: sensors.${tier} must be an object`);
    }
    for (const sourceMedium of SENSOR_MEDIA) {
      const targetRadii = matrix[sourceMedium];
      if (!targetRadii || typeof targetRadii !== 'object') {
        throw new Error(
          `Invalid ${context}: sensors.${tier}.${sourceMedium} must be an object`,
        );
      }
      for (const targetMedium of SENSOR_MEDIA) {
        assertFiniteNonNegativeRadius(
          `Invalid ${context}: sensors.${tier}.${sourceMedium}.${targetMedium}`,
          targetRadii[targetMedium],
        );
      }
    }
  }
  assertFiniteNonNegativeRadius(
    `Invalid ${context}: sensors.detectorRadius`,
    sensors.detectorRadius,
  );
}

export function getMaximumSensorMatrixRadius(
  matrix: SensorMediumRadiusMatrix,
): number {
  return Math.max(
    matrix.aboveWater.aboveWater,
    matrix.aboveWater.underwater,
    matrix.underwater.aboveWater,
    matrix.underwater.underwater,
  );
}

export function hasAnySensorRadius(sensors: SensorCapabilityConfig): boolean {
  return (
    getMaximumSensorMatrixRadius(sensors.fullSight) > 0 ||
    getMaximumSensorMatrixRadius(sensors.contactSight) > 0 ||
    sensors.detectorRadius > 0
  );
}

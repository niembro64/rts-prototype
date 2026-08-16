import type {
  SensorCapabilityConfig,
  SensorMediumRadiusMatrix,
  SensorMediumTargetRadii,
} from '../../types/blueprints';
import { assertNonNegativeFiniteNumber } from '../../configValidation';

export type SensorMedium = 'aboveWater' | 'underwater';

const SENSOR_MEDIA: readonly SensorMedium[] = [
  'aboveWater',
  'underwater',
];

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
    radarJamRadius: sensors.radarJamRadius,
    sonarJamRadius: sensors.sonarJamRadius,
  };
}

function assertFiniteNonNegativeRadius(context: string, value: number): void {
  assertNonNegativeFiniteNumber(value, context);
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
  assertFiniteNonNegativeRadius(
    `Invalid ${context}: sensors.radarJamRadius`,
    sensors.radarJamRadius,
  );
  assertFiniteNonNegativeRadius(
    `Invalid ${context}: sensors.sonarJamRadius`,
    sensors.sonarJamRadius,
  );

  // THE MEDIUM GATE, and the reason it is a rule rather than a habit.
  //
  // Beyond All Reason states this once, in modrules, as
  // `requireSonarUnderWater = true`: an underwater target is revealed by SONAR,
  // and line of sight alone will not do it. We can express the same thing in
  // the matrix by leaving every fullSight[*][underwater] cell at zero — and
  // that is exactly what all 35 of our sensor suites do today.
  //
  // Expressed that way it is 70 zeros staying zero across 35 files, and one
  // stray number silently makes some tank a submarine detector. So state it:
  // a suite may see underwater only if it can also HEAR underwater.
  for (const sourceMedium of SENSOR_MEDIA) {
    const seesUnderwater = sensors.fullSight[sourceMedium].underwater > 0;
    const hearsUnderwater = sensors.contactSight[sourceMedium].underwater > 0;
    if (seesUnderwater && !hearsUnderwater) {
      throw new Error(
        `Invalid ${context}: sensors.fullSight.${sourceMedium}.underwater is `
          + `${sensors.fullSight[sourceMedium].underwater} but `
          + `sensors.contactSight.${sourceMedium}.underwater is 0. A submerged `
          + 'target is found by sonar; sight alone does not reach it. Give this '
          + 'suite a sonar radius or take its underwater sight away.',
      );
    }
  }
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

/** True when this suite does ANYTHING sensor-shaped, including denying the
 *  enemy's sensors. This gates the source walk in sensorCoverage, so a channel
 *  missing from here is a channel the whole visibility pass never sees.
 *
 *  Jamming counts. A mount authored with a jam radius and no sight, contact, or
 *  detector radius of its own -- BAR's armjamt shape, minus its 195 sightdistance
 *  -- was dropped here and then silently jammed nothing. Both jammers in the
 *  current roster happen to carry sight as well, which is the only reason the
 *  hole is invisible today. */
export function hasAnySensorRadius(sensors: SensorCapabilityConfig): boolean {
  return (
    getMaximumSensorMatrixRadius(sensors.fullSight) > 0 ||
    getMaximumSensorMatrixRadius(sensors.contactSight) > 0 ||
    sensors.detectorRadius > 0 ||
    sensors.radarJamRadius > 0 ||
    sensors.sonarJamRadius > 0
  );
}

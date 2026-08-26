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

  // THE WATERLINE RULE, and the reason it is a rule rather than a habit.
  //
  // Full sight crosses the waterline: water is a medium, not an occluder, so
  // an enemy inside a sensor's sight radius is seen whichever side of the
  // surface it is on. Each fullSight source row therefore authors the SAME
  // radius for both target columns. (Beyond All Reason's
  // `requireSonarUnderWater` modrule was the previous convention here — every
  // fullSight[*][underwater] cell at zero — but BAR's sonar reveals a full
  // model inside its range while ours is an anonymous contact tier, so the
  // pairing left a surface hull touching a submarine with a dot and never the
  // unit. That contradicted the promise that anything inside team sight is
  // fully visible.) Contact sight stays per medium on purpose: radar is the
  // above->above lane and sonar the under->under lane.
  //
  // Expressed only as repeated numbers, one stray edit silently blinds some
  // hull across the surface. So state it.
  for (const sourceMedium of SENSOR_MEDIA) {
    const row = sensors.fullSight[sourceMedium];
    const sameMedium = row[sourceMedium];
    const crossMedium = row[sourceMedium === 'aboveWater' ? 'underwater' : 'aboveWater'];
    if (sameMedium !== crossMedium) {
      throw new Error(
        `Invalid ${context}: sensors.fullSight.${sourceMedium} authors `
          + `${sameMedium} for its own medium but ${crossMedium} across the `
          + 'waterline. Full sight crosses the waterline: author the same '
          + 'radius for both target media (contact sight stays per medium).',
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
 *  -- was dropped here and then silently jammed nothing. Both jammer BUILDINGS
 *  now author exactly that shape (zero sight, contact and detector), so this
 *  gate is what keeps them jamming at all. */
export function hasAnySensorRadius(sensors: SensorCapabilityConfig): boolean {
  return (
    getMaximumSensorMatrixRadius(sensors.fullSight) > 0 ||
    getMaximumSensorMatrixRadius(sensors.contactSight) > 0 ||
    sensors.detectorRadius > 0 ||
    sensors.radarJamRadius > 0 ||
    sensors.sonarJamRadius > 0
  );
}

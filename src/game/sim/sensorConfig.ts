import type { SensorCapabilityConfig } from '../../types/blueprints';
import { assertNonNegativeFiniteNumber } from '../../configValidation';

export type SensorMedium = 'aboveWater' | 'underwater';

export function cloneSensorCapabilityConfig(
  sensors: SensorCapabilityConfig,
): SensorCapabilityConfig {
  return {
    visionRadius: sensors.visionRadius,
    radarRadius: sensors.radarRadius,
    detectorRadius: sensors.detectorRadius,
    jammingRadius: sensors.jammingRadius,
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
  assertFiniteNonNegativeRadius(
    `Invalid ${context}: sensors.visionRadius`,
    sensors.visionRadius,
  );
  assertFiniteNonNegativeRadius(
    `Invalid ${context}: sensors.radarRadius`,
    sensors.radarRadius,
  );
  assertFiniteNonNegativeRadius(
    `Invalid ${context}: sensors.detectorRadius`,
    sensors.detectorRadius,
  );
  assertFiniteNonNegativeRadius(
    `Invalid ${context}: sensors.jammingRadius`,
    sensors.jammingRadius,
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
    sensors.visionRadius > 0 ||
    sensors.radarRadius > 0 ||
    sensors.detectorRadius > 0 ||
    sensors.jammingRadius > 0
  );
}

/** Convert authoritative linear wind speed to turbine angular speed.
 *
 * tipSpeedRatio = (angularSpeed * rotorRadius) / windSpeed
 * therefore angularSpeed = windSpeed * tipSpeedRatio / rotorRadius.
 */
export function windRotorAngularSpeed(
  windSpeedWorldPerSecond: number,
  rotorRadiusWorld: number,
  tipSpeedRatio: number,
): number {
  if (
    !Number.isFinite(windSpeedWorldPerSecond) || windSpeedWorldPerSecond <= 0 ||
    !Number.isFinite(rotorRadiusWorld) || rotorRadiusWorld <= 0 ||
    !Number.isFinite(tipSpeedRatio) || tipSpeedRatio <= 0
  ) return 0;
  return windSpeedWorldPerSecond * tipSpeedRatio / rotorRadiusWorld;
}

type Vector3Like = Readonly<{ x: number; y: number; z: number }>;
type AngularActuatorLike = Readonly<{ maxSpeed: number; maxAcceleration: number }>;
type EmissionSocketLike = Readonly<{ offset: Vector3Like }>;

export function validateFiniteVector3(
  label: string,
  field: string,
  vector: Vector3Like,
  units: string,
): void {
  if (
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  ) return;
  const unitSuffix = units.length > 0 ? ` ${units}` : '';
  throw new Error(`Invalid ${label}: ${field} x/y/z must be finite${unitSuffix}`);
}

export function validatePositiveAngularActuator(
  label: string,
  actuator: AngularActuatorLike,
  limitDescription = 'limits',
): void {
  if (
    Number.isFinite(actuator.maxSpeed) &&
    actuator.maxSpeed > 0 &&
    Number.isFinite(actuator.maxAcceleration) &&
    actuator.maxAcceleration > 0
  ) return;
  throw new Error(
    `Invalid ${label}: maxSpeed and maxAcceleration must be finite positive ${limitDescription}`,
  );
}

export function validateEmissionSocketLayout(
  label: string,
  sockets: readonly EmissionSocketLike[] | undefined,
  expectedLaneCount: number | undefined,
): void {
  if (sockets === undefined) return;
  if (sockets.length !== expectedLaneCount) {
    throw new Error(
      `Invalid emission sockets for ${label}: expected exactly ${String(expectedLaneCount)} ` +
      'QueryWeapon lane(s)',
    );
  }
  for (const socket of sockets) {
    validateFiniteVector3(`emission socket for ${label}`, 'offset', socket.offset, 'world units');
  }
}

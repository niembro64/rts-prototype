function quantizeFixedPoint(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}

export const ENTITY_POSITION_WIRE_SCALE = 100;
export const MINIMAP_POSITION_WIRE_SCALE = 1;
export const PROJECTILE_POSITION_WIRE_SCALE = 1;
export const VELOCITY_WIRE_SCALE = 10;
export const ROTATION_WIRE_SCALE = 1000;
export const NORMAL_WIRE_SCALE = 1000;
export const SUSPENSION_WIRE_SCALE = 100;

export function quantizeEntityPosition(value: number): number {
  return quantizeFixedPoint(value, ENTITY_POSITION_WIRE_SCALE);
}

export function quantizeMinimapPosition(value: number): number {
  return Math.round(value * MINIMAP_POSITION_WIRE_SCALE);
}

export function quantizeProjectilePosition(value: number): number {
  return Math.round(value * PROJECTILE_POSITION_WIRE_SCALE);
}

export function quantizeVelocity(value: number): number {
  return quantizeFixedPoint(value, VELOCITY_WIRE_SCALE);
}

export function quantizeRotation(value: number): number {
  return quantizeFixedPoint(value, ROTATION_WIRE_SCALE);
}

export function quantizeNormal(value: number): number {
  return quantizeFixedPoint(value, NORMAL_WIRE_SCALE);
}

export function quantizeSuspension(value: number): number {
  return quantizeFixedPoint(value, SUSPENSION_WIRE_SCALE);
}

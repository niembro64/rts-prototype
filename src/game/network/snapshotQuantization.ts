const ENTITY_POSITION_WIRE_SCALE = 100;
const MINIMAP_POSITION_WIRE_SCALE = 1;
const PROJECTILE_POSITION_WIRE_SCALE = 1;
const VELOCITY_WIRE_SCALE = 10;
const ROTATION_WIRE_SCALE = 1000;
const NORMAL_WIRE_SCALE = 1000;

function quantizeFixedPoint(value: number, scale: number): number {
  return Math.round(value * scale);
}

function dequantizeFixedPoint(value: number, scale: number): number {
  return value / scale;
}

export function quantizeEntityPosition(value: number): number {
  return quantizeFixedPoint(value, ENTITY_POSITION_WIRE_SCALE);
}

export function dequantizeEntityPosition(value: number): number {
  return dequantizeFixedPoint(value, ENTITY_POSITION_WIRE_SCALE);
}

export function quantizeMinimapPosition(value: number): number {
  return Math.round(value * MINIMAP_POSITION_WIRE_SCALE);
}


export function quantizeProjectilePosition(value: number): number {
  return Math.round(value * PROJECTILE_POSITION_WIRE_SCALE);
}

export function dequantizeProjectilePosition(value: number): number {
  return dequantizeFixedPoint(value, PROJECTILE_POSITION_WIRE_SCALE);
}

export function quantizeVelocity(value: number): number {
  return quantizeFixedPoint(value, VELOCITY_WIRE_SCALE);
}

export function dequantizeVelocity(value: number): number {
  return dequantizeFixedPoint(value, VELOCITY_WIRE_SCALE);
}

export function quantizeRotation(value: number): number {
  return quantizeFixedPoint(value, ROTATION_WIRE_SCALE);
}

export function dequantizeRotation(value: number): number {
  return dequantizeFixedPoint(value, ROTATION_WIRE_SCALE);
}

export function quantizeNormal(value: number): number {
  return quantizeFixedPoint(value, NORMAL_WIRE_SCALE);
}

export function dequantizeNormal(value: number): number {
  return dequantizeFixedPoint(value, NORMAL_WIRE_SCALE);
}

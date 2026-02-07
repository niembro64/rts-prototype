// Tread class - handles animated treads and wheels for tanks and vehicles (client-side only)
// Tracks attachment point position over time to calculate precise velocity at that point

export interface TreadConfig {
  // Attachment point offset relative to unit center (in unit's local space)
  attachOffsetX: number;  // Forward/back offset (positive = forward)
  attachOffsetY: number;  // Left/right offset (positive = right side)

  // Wheel visual parameters
  wheelRadius: number;    // Radius of wheels for rotation calculation

  // Animation parameters
  rotationSpeedMultiplier: number;  // Multiplier on velocity (default 2x for visual effect)
}

export class Tread {
  private config: TreadConfig;

  // Current wheel/tread rotation angle (radians)
  private currentRotation: number = 0;

  // Previous attachment point position for velocity calculation
  private prevAttachX: number = 0;
  private prevAttachY: number = 0;

  // Has the tread been initialized with a position?
  private initialized: boolean = false;

  constructor(config: TreadConfig) {
    this.config = config;
  }

  // Initialize tread at a specific unit position (call immediately after construction)
  // This prevents incorrect velocity on first frame
  initializeAt(unitX: number, unitY: number, unitRotation: number): void {
    const attach = this.getAttachmentPoint(unitX, unitY, unitRotation);
    this.prevAttachX = attach.x;
    this.prevAttachY = attach.y;
    this.initialized = true;
  }

  // Update the tread based on unit position
  // Calculates velocity at attachment point and updates rotation
  update(
    unitX: number,
    unitY: number,
    unitRotation: number,
    dtMs: number
  ): void {
    const dtSec = dtMs / 1000;
    if (dtSec <= 0) return;

    // Calculate current attachment point in world coordinates
    const attach = this.getAttachmentPoint(unitX, unitY, unitRotation);

    // Initialize on first update
    if (!this.initialized) {
      this.prevAttachX = attach.x;
      this.prevAttachY = attach.y;
      this.initialized = true;
      return;
    }

    // Calculate velocity at attachment point from position delta
    const dx = attach.x - this.prevAttachX;
    const dy = attach.y - this.prevAttachY;

    // Calculate the forward direction (unit's facing direction)
    const forwardX = Math.cos(unitRotation);
    const forwardY = Math.sin(unitRotation);

    // Project velocity onto the forward direction to get "rolling" speed
    // This ensures the tread rotates based on how much it moved along its rolling axis
    const forwardVelocity = (dx * forwardX + dy * forwardY) / dtSec;

    // Update rotation based on forward velocity
    // Rotation = distance / circumference * 2π, but we use radius directly
    // Angular velocity = linear velocity / radius
    const wheelCircumference = 2 * Math.PI * this.config.wheelRadius;
    const distanceTraveled = forwardVelocity * dtSec;
    const rotationDelta = (distanceTraveled / wheelCircumference) *
                          this.config.rotationSpeedMultiplier *
                          2 * Math.PI;

    this.currentRotation += rotationDelta;

    // Keep rotation in reasonable range to prevent floating point issues
    while (this.currentRotation > Math.PI * 2) {
      this.currentRotation -= Math.PI * 2;
    }
    while (this.currentRotation < -Math.PI * 2) {
      this.currentRotation += Math.PI * 2;
    }

    // Store current position for next frame
    this.prevAttachX = attach.x;
    this.prevAttachY = attach.y;
  }

  // Get the current wheel/tread rotation angle (radians)
  getRotation(): number {
    return this.currentRotation;
  }

  // Get attachment point in world coordinates
  getAttachmentPoint(
    unitX: number,
    unitY: number,
    unitRotation: number
  ): { x: number; y: number } {
    const cos = Math.cos(unitRotation);
    const sin = Math.sin(unitRotation);
    return {
      x: unitX + cos * this.config.attachOffsetX - sin * this.config.attachOffsetY,
      y: unitY + sin * this.config.attachOffsetX + cos * this.config.attachOffsetY,
    };
  }

  // Get the wheel radius (for rendering calculations)
  getWheelRadius(): number {
    return this.config.wheelRadius;
  }

  // Get the attachment offset Y (to identify left vs right side)
  getSide(): number {
    return this.config.attachOffsetY > 0 ? 1 : -1;
  }
}

// Factory functions for common tread configurations

export interface TankTreadSetup {
  leftTread: Tread;
  rightTread: Tread;
}

// Create a pair of tank treads (left and right)
export function createTankTreads(
  unitRadius: number,
  rotationMultiplier: number = 1.0
): TankTreadSetup {
  const treadOffset = unitRadius * 0.85;  // Same as drawTankUnit
  const treadWidth = unitRadius * 0.5;
  const wheelRadius = treadWidth * 0.35;  // Same as drawn wheel size

  const leftTread = new Tread({
    attachOffsetX: 0,
    attachOffsetY: -treadOffset,  // Left side (negative Y)
    wheelRadius: wheelRadius,
    rotationSpeedMultiplier: rotationMultiplier,
  });

  const rightTread = new Tread({
    attachOffsetX: 0,
    attachOffsetY: treadOffset,   // Right side (positive Y)
    wheelRadius: wheelRadius,
    rotationSpeedMultiplier: rotationMultiplier,
  });

  return { leftTread, rightTread };
}

// Create a pair of brawl treads (left and right)
// Brawl has narrower treads than tank
export function createBrawlTreads(
  unitRadius: number,
  rotationMultiplier: number = 1.0
): TankTreadSetup {
  const treadOffset = unitRadius * 0.75;  // Same as drawBrawlUnit
  const treadWidth = unitRadius * 0.4;
  const wheelRadius = treadWidth * 0.3;   // Smaller wheels for brawl

  const leftTread = new Tread({
    attachOffsetX: 0,
    attachOffsetY: -treadOffset,  // Left side (negative Y)
    wheelRadius: wheelRadius,
    rotationSpeedMultiplier: rotationMultiplier,
  });

  const rightTread = new Tread({
    attachOffsetX: 0,
    attachOffsetY: treadOffset,   // Right side (positive Y)
    wheelRadius: wheelRadius,
    rotationSpeedMultiplier: rotationMultiplier,
  });

  return { leftTread, rightTread };
}

export interface VehicleWheelSetup {
  wheels: Tread[];  // Array of 2-4 wheels
}

// Create four wheels for scout-style vehicles
export function createScoutWheelSetup(
  unitRadius: number,
  rotationMultiplier: number = 1.0
): VehicleWheelSetup {
  const wheelDistX = unitRadius * 0.55;  // Forward/back offset
  const wheelDistY = unitRadius * 0.65;  // Left/right offset
  const wheelRadius = unitRadius * 0.28;

  const wheels = [
    // Front right
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Front left
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear right
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear left
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
  ];

  return { wheels };
}

// Create four wheels for burst-style vehicles
export function createBurstWheelSetup(
  unitRadius: number,
  rotationMultiplier: number = 1.0
): VehicleWheelSetup {
  const wheelDistX = unitRadius * 0.6;   // Forward/back offset
  const wheelDistY = unitRadius * 0.7;   // Left/right offset
  const wheelRadius = unitRadius * 0.25;

  const wheels = [
    // Front right
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Front left
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear right
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear left
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
  ];

  return { wheels };
}

// Create four wheels for mortar-style vehicles
export function createMortarWheelSetup(
  unitRadius: number,
  rotationMultiplier: number = 1.0
): VehicleWheelSetup {
  const wheelDistX = unitRadius * 0.6;   // Forward/back offset
  const wheelDistY = unitRadius * 0.65;  // Left/right offset
  const wheelRadius = unitRadius * 0.22;

  const wheels = [
    // Front right
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Front left
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear right
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear left
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
  ];

  return { wheels };
}

// Create four wheels - for snipe style vehicles
// Matches the snipe unit's wheel layout (corners of a rectangle)
export function createFourWheelSetup(
  unitRadius: number,
  rotationMultiplier: number = 1.0
): VehicleWheelSetup {
  // Match snipe wheel positions exactly
  const wheelDistX = unitRadius * 0.7;
  const wheelDistY = unitRadius * 0.5;
  const wheelRadius = unitRadius * 0.22;

  const wheels = [
    // Front right (matches snipe's first wheel position)
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Front left
    new Tread({
      attachOffsetX: wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear right
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
    // Rear left
    new Tread({
      attachOffsetX: -wheelDistX,
      attachOffsetY: -wheelDistY,
      wheelRadius: wheelRadius,
      rotationSpeedMultiplier: rotationMultiplier,
    }),
  ];

  return { wheels };
}

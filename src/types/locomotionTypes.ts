// Runtime locomotion profile used by movement physics and rendering.

export type UnitLocomotion = {
  type: 'wheels' | 'treads' | 'legs';
  /** Authored propulsion scalar supplied by the locomotion blueprint. */
  driveForce: number;
  /** Ground traction coefficient. This is coupling to terrain, not drag. */
  traction: number;
};

/** Runtime chassis suspension profile. Offsets are in chassis-local
 *  axes: x = forward, y = lateral/left, z = up. This is visual/body
 *  compliance around the authoritative physics body; jump lift itself
 *  is applied as force to the physics body. */
export type UnitSuspensionConfig = {
  /** Hooke spring stiffness in force / world-unit. */
  stiffness: number;
  /** 1 = critical damping, <1 = bouncy, >1 = heavy/sticky. */
  dampingRatio: number;
  /** Visual body mass multiplier relative to the unit's physics mass. */
  massScale?: number;
  /** Maximum absolute visual displacement in each local axis. Ground
   *  contact is owned by the physics body, not this clamp. */
  maxOffset?: { x?: number; y?: number; z?: number };
};

export type UnitJumpConfig = {
  /** Upward actuator force. Applied only while the locomotion ground
   *  point is at or below terrain height. */
  force: number;
  /** Manual jumps consume a command; always jumps fire every grounded tick. */
  mode?: 'manual' | 'always';
};

export type UnitSuspensionState = {
  config: UnitSuspensionConfig;
  jump?: UnitJumpConfig;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  jumpRequested: boolean;
  jumpActive: boolean;
  legContact: boolean;
  anchorVelocityX: number;
  anchorVelocityY: number;
  anchorVelocityZ: number;
  anchorVelocityInitialized: boolean;
};

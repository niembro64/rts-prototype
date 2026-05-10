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
  /** Spring constant for the charged launch spring, in force / world-unit. */
  springStiffness: number;
  /** Preloaded spring compression distance. Potential energy is
   *  0.5 * springStiffness * compression^2. */
  compression: number;
  /** Manual jumps consume a command; always jumps release once per ground contact. */
  mode?: 'manual' | 'always';
};

export type UnitJumpState = {
  config: UnitJumpConfig;
  /** Set by player/AI command and consumed by the next actuator tick. */
  requested: boolean;
  /** True after a spring release; recharge is allowed once grounded and no longer moving outward. */
  active: boolean;
  /** Monotonic server-authored launch edge counter used by clients to reset visual drift. */
  launchSeq: number;
};

export type UnitSuspensionState = {
  config: UnitSuspensionConfig;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  legContact: boolean;
  anchorVelocityX: number;
  anchorVelocityY: number;
  anchorVelocityZ: number;
  anchorVelocityInitialized: boolean;
};

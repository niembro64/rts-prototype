// Runtime locomotion profile used by movement physics and rendering.

export type UnitLocomotion = {
  type: 'wheels' | 'treads' | 'legs' | 'hover' | 'flying';
  /** Authored propulsion scalar supplied by the locomotion blueprint. */
  driveForce: number;
  /** Ground traction coefficient. This is coupling to terrain, not drag.
   *  For hover units this acts as a horizontal-thrust scalar (no actual
   *  ground contact); 1.0 is full authority. */
  traction: number;
  /** Maximum traversable slope in degrees from horizontal. Hovers
   *  ignore terrain slope, but the field stays for path-validity
   *  uniformity (set near 90°). */
  maxSlopeDeg: number;
  /** Precomputed cosine threshold for pathfinding against terrain normals. */
  minSurfaceNormalZ: number;
  /** Hover-only: target altitude above the ground directly below the
   *  unit, in world units. The hover physics integrator uses this to
   *  size the inverse-distance lift force so that the equilibrium
   *  height (where F_up = m·g) sits at hoverHeight. Undefined for
   *  ground locomotion. */
  hoverHeight?: number;
  /** Hover/flying-only: per-tick uniform randomization of `hoverHeight`
   *  expressed as a fraction. Each tick the lift force uses
   *  hoverHeight * (1 + U(-amount, +amount)). Undefined or 0 means no
   *  randomization. */
  hoverHeightRandomizationAmount?: number;
};

/** Runtime chassis suspension profile. Offsets are in chassis-local
 *  axes: x = forward, y = lateral/left, z = up. This is visual/body
 *  compliance around the authoritative physics body. */
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

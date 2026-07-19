// Runtime locomotion profile used by movement physics and rendering.

export type UnitLocomotionResistancePhysics = {
  /** Passive translational damping rate for this medium, in s^-1. */
  linearDampingRate: number;
  /** Passive angular damping rate for this medium, in s^-1. */
  angularDampingRate: number;
};

export type UnitLocomotionLiftPhysics = {
  /** Passive buoyancy as a fraction of body weight at full occupancy, in [0, 1]. */
  buoyancyRatio: number;
  /** Powered support thrust sourced from the probe-averaged distance to the
   *  highest solid ground/support surface. */
  surfaceFollowingForceFromGround: number;
  /** Powered support thrust sourced from the probe-averaged distance to exposed
   *  water. Always zero for water-medium physics. */
  surfaceFollowingForceFromWater: number;
};

export type UnitLocomotionGroundPhysics = {
  /** Maximum force the ground actuator can request before traction limits it. */
  maxPropulsiveForce: number;
  /** Coulomb static-friction coefficient for the contact patch. */
  staticFrictionCoefficient: number;
  /** Passive tangent-velocity damping rate while supported, in s^-1. */
  tangentialDampingRate: number;
};

export type UnitLocomotionFluidPhysics = {
  /** Maximum directed propulsion force supplied while occupying this medium. */
  maxPropulsiveForce: number;
  resistance: UnitLocomotionResistancePhysics;
  lift: UnitLocomotionLiftPhysics;
};

export type UnitLocomotionMediumPhysics =
  | UnitLocomotionGroundPhysics
  | UnitLocomotionFluidPhysics;

export type UnitLocomotionPhysics = {
  ground: UnitLocomotionGroundPhysics;
  air: UnitLocomotionFluidPhysics;
  water: UnitLocomotionFluidPhysics;
};

/** The authored locomotion mechanism, used for the visual rig and motion
 * presentation. Route permissions are stored separately in navigation. */
export type UnitLocomotionType =
  | 'wheels'
  | 'treads'
  | 'amphibious-treads'
  | 'legs'
  | 'flippers'
  | 'hover'
  | 'flying'
  | 'submarine'
  | 'dive';

export type SurfaceProbeSetId = '1-point' | '5-points' | '8-points';

export type UnitLocomotion = {
  /** Authored mechanism used by presentation; physics is expanded below. */
  type: UnitLocomotionType;
  /** Explicit preset expanded into the complete applicable profile at load. */
  physicsPresetId: string;
  /** Fully-abstracted medium physics. Every unit owns each medium profile;
   *  zero propulsion makes a medium inert, while concepts that do not apply
   *  to that medium are structurally absent. */
  physics: UnitLocomotionPhysics;
  /** Environmental failure policy, independent from propulsion and lift. */
  environmentalHazards: {
    waterFatal: boolean;
    fatalSubmergedFraction: number;
    fatalExposureSeconds: number;
  };
  actuator: {
    /** Axis through which the locomotion actuator can apply horizontal force. */
    propulsionAxis: 'bodyForward' | 'worldPlanar';
  };
  motionControl: {
    /** Air propulsion continues along the nose with no waypoint thrust input. */
    cruiseWhenUncommanded: boolean;
    /** True when waypoint arrival keeps full directed thrust instead of
     * braking/slowing at final waypoints or honoring action speed limits. */
    maintainFullThrustAtWaypoints: boolean;
  };
  surfaceFollowing: {
    /** Named sampling layout used for air and water support forces. */
    altitudeProbeSetId: SurfaceProbeSetId;
  };
  /** Explicit gameplay route permissions. Physics still determines whether
   *  the body can actually produce useful force in an allowed domain. */
  navigation: {
    allowOnGround: boolean;
    allowInAir: boolean;
    allowInWater: boolean;
  };
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

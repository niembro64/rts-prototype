// Runtime locomotion profile used by movement physics and rendering.

export type UnitLocomotionResistancePhysics = {
  /** Passive translational damping rate for this medium, in s^-1. */
  linearDampingRate: number;
  /** Passive angular damping rate for this medium, in s^-1. */
  angularDampingRate: number;
};

export type UnitLocomotionAirLiftPhysics = {
  /** Inverse-distance support-force coefficient sourced from the probe-averaged
   *  distance to the highest solid ground/support surface. */
  surfaceFollowingInverseForceFromGround: number;
  /** Inverse-distance support-force coefficient sourced from the probe-averaged
   *  distance to exposed water. */
  surfaceFollowingInverseForceFromWater: number;
};

export type UnitLocomotionWaterLiftPhysics = {
  /** Inverse-distance support-force coefficient sourced from the probe-averaged
   *  distance to the lakebed or highest solid support surface. */
  surfaceFollowingInverseForceFromGround: number;
  /** Upward-force coefficient per world unit of probe-averaged depth below the
   *  exposed water surface. */
  surfaceFollowingProportionalForceFromWater: number;
};

export type UnitLocomotionGroundPhysics = {
  /** Maximum directed propulsion force while supported by solid ground. */
  maxPropulsiveForce: number;
  /** Coulomb static-friction coefficient for the contact patch. */
  staticFrictionCoefficient: number;
  /** Passive tangent-velocity damping rate while supported, in s^-1. */
  tangentialDampingRate: number;
};

export type UnitLocomotionAirFluidPhysics = {
  /** Maximum directed propulsion force while occupying air. */
  maxPropulsiveForce: number;
  resistance: UnitLocomotionResistancePhysics;
  lift: UnitLocomotionAirLiftPhysics;
};

export type UnitLocomotionWaterFluidPhysics = {
  /** Maximum directed propulsion force while occupying water. */
  maxPropulsiveForce: number;
  resistance: UnitLocomotionResistancePhysics;
  lift: UnitLocomotionWaterLiftPhysics;
};

export type UnitLocomotionPhysics = {
  ground: UnitLocomotionGroundPhysics;
  air: UnitLocomotionAirFluidPhysics;
  water: UnitLocomotionWaterFluidPhysics;
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

export type SurfaceProbeSetId = 'single' | 'few' | 'many';

export type UnitNavigationDomain = Readonly<{
  allowOnGround: boolean;
  allowInAir: boolean;
  allowInWater: boolean;
}>;

export type UnitLocomotion = {
  /** Authored mechanism used by presentation; physics is expanded below. */
  type: UnitLocomotionType;
  /** Explicit preset expanded into the complete applicable profile at load. */
  physicsPresetId: string;
  /** Fully-abstracted medium physics. Every unit owns each medium profile;
   *  concepts that do not apply to a medium are structurally absent. */
  physics: UnitLocomotionPhysics;
  /** Environmental failure policy, independent from propulsion and lift. */
  environmentalHazards: {
    /** Hit points lost per second while the authoritative body origin is
     * strictly below the water plane. Zero makes the unit water-safe. */
    waterDamagePerSecond: number;
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
  /** Intent and physical traversal are deliberately separate. Waypoint
   *  permissions decide where orders may terminate; move permissions are
   *  derived from actual positive propulsion in each medium. */
  navigation: {
    waypoint: UnitNavigationDomain;
    move: UnitNavigationDomain;
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

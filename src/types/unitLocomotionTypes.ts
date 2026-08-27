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
  /** Passive angular damping rate while supported, in s^-1. */
  angularDampingRate: number;
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
  | 'rover'
  | 'tank'
  | 'amphibious-tank'
  | 'crawler'
  /** Biped: two legs and two arms, on its own rig. A mech leg is a hinge in
   *  one vertical plane and the hips yaw inside the hull, so the torso can
   *  face what it is shooting while the legs walk somewhere else. Shares
   *  nothing with `crawler`, which solves an arachnid. */
  | 'bot'
  | 'amphibian'
  | 'drone'
  | 'plane'
  | 'submarine'
  | 'aerosub';

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
    /** Hit points lost per second while the whole authoritative body sits
     * above the water plane (origin minus radius at or above it) — a hull
     * resting on dry ground. Zero makes the unit land-safe. */
    landDamagePerSecond: number;
  };
  actuator: {
    /** Axis through which the locomotion actuator can apply horizontal force.
     * `worldPlanar` drives directly along the requested direction;
     * `waypointForward` projects the request onto the nose (signed, may
     * reverse); `waypointForwardOnly` is the same but powers only forward —
     * the unit turns toward the waypoint before it starts moving;
     * `alwaysForward` keeps full throttle along the nose every tick — the
     * request only aims the yaw servo, so forward flight never slows in a
     * turn (plane, aerosub). */
    propulsionAxis: 'waypointForward' | 'waypointForwardOnly' | 'worldPlanar' | 'alwaysForward';
    /** `alwaysForward` chassis only: the constant-rate yaw slew in degrees
     * per second — the circle turn. The nose turns at exactly this rate
     * until aligned, then snaps onto the bearing; it never eases off as the
     * error shrinks the way a damped spring does. The waypoint deadzone's
     * turn radius derives from the same number: R = speed / rate. */
    turnRateDegreesPerSecond?: number;
  };
  motionControl: {
    /** Air propulsion continues along the nose with no waypoint thrust input. */
    cruiseWhenUncommanded: boolean;
    /** True when waypoint arrival keeps full directed thrust instead of
     * braking/slowing at final waypoints or honoring action speed limits. */
    maintainFullThrustAtWaypoints: boolean;
    /** True when the final-waypoint brake is part of the chassis identity
     * (hover locomotion): the global slowDownAtFinalWaypoint BATTLE setting
     * may never strip it. Mutually exclusive with
     * maintainFullThrustAtWaypoints. */
    alwaysBrakeAtFinalWaypoint: boolean;
    /** Cruise (forward-flight) presets only. Inside the deadzone —
     * `turnRadiusMultiplier x the natural turn radius` around the current
     * waypoint — the unit may only keep turning while that waypoint sits
     * within `frontSliceDegrees` left or right of its nose; anywhere else in
     * the deadzone it may not turn at all, so a miss is a large straight
     * miss that clears the deadzone before the free turn-back. */
    waypointDeadzone?: {
      turnRadiusMultiplier: number;
      frontSliceDegrees: number;
    };
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

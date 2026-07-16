// Runtime locomotion profile used by movement physics and rendering.

type UnitPathfindingTerrainMode = 'land' | 'anywhere';

export type UnitPathfindingConfig = {
  pathfindingBlueprintId: string;
  terrainMode: UnitPathfindingTerrainMode;
  /** True for profiles that can route over water and steep terrain. */
  ignoreTerrainBlocking: boolean;
};

export type UnitLocomotionPropulsionPhysics = {
  /** Absolute propulsion force owned by this locomotion preset and medium. */
  driveForce: number;
  /** Coupling coefficient that converts drive force into directed thrust and
   *  attitude torque in this medium. */
  forceCoupling: number;
};

export type UnitLocomotionResistancePhysics = {
  /** Fraction of the global linear damping rate for this medium, in [0, 1]. */
  frictionMultiplier: number;
  /** Quadratic fluid drag rate. */
  quadraticDrag: number;
  /** Drag multipliers in body-forward, body-lateral, and world-vertical axes. */
  directionalScale: { forward: number; lateral: number; vertical: number };
  /** Passive angular damping supplied by this occupied fluid. */
  angularDrag: number;
};

export type UnitLocomotionLiftPhysics = {
  /** Fraction of gravity passively countered at full medium occupancy, in [0, 1]. */
  gravityCounterRatio: number;
  /** Upward force sourced from the probe-averaged distance to the highest
   *  solid ground/support surface. */
  liftForceFromGroundSurface: number;
  /** Upward force sourced from the probe-averaged distance to exposed water.
   *  Always zero for water-medium physics. */
  liftForceFromWaterSurface: number;
  /** Per-tick uniform randomization of the full-medium surface lift force. */
  randomizationAmount: number;
  /** EMA weight applied before medium occupancy weighting, in [0, 1). */
  ema: number;
};

export type UnitLocomotionGroundPhysics = {
  propulsion: UnitLocomotionPropulsionPhysics;
  resistance: Pick<UnitLocomotionResistancePhysics, 'frictionMultiplier'>;
  contact: {
    /** Coulomb-style limit on force transmitted through solid contact. */
    surfaceGrip: number;
    /** Tangent damping scale for the support-contact solver. */
    tangentDamping: number;
  };
};

export type UnitLocomotionFluidPhysics = {
  propulsion: UnitLocomotionPropulsionPhysics;
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

export type LocomotionMediumNavigation = 'air-only' | 'water-only' | 'air-and-water';

export type LocomotionNavigationPolicy = {
  /** Whether this locomotion preset may deliberately route while supported
   *  by a ground contact patch. */
  allowOnGround: boolean;
  /** Fluid domains this preset may deliberately route through. Actual route
   *  capability still requires usable authored propulsion in that medium. */
  allowInMedium: LocomotionMediumNavigation;
};

export type SurfaceProbeSetId = '1-point' | '5-points' | '8-points';

export type UnitLocomotion = {
  /** Presentation rig only. Authoritative physics never selects behavior
   *  from this discriminant. */
  type: 'wheels' | 'treads' | 'legs' | 'flippers' | 'hover' | 'flying' | 'swim';
  /** Explicit preset expanded into the complete applicable profile at load. */
  physicsPresetId: string;
  /** Fully-abstracted medium physics. Every unit owns each medium profile;
   *  zero propulsion makes a medium inert, while concepts that do not apply
   *  to that medium are structurally absent. */
  physics: UnitLocomotionPhysics;
  /** Type/preset-level navigation policy expanded from locomotionConfig.json. */
  navigation: LocomotionNavigationPolicy;
  /** Environmental failure policy, independent from propulsion/lift. */
  survival: {
    waterFatal: boolean;
    fatalSubmergedFraction: number;
    fatalExposureSeconds: number;
  };
  /** Air propulsion continues along the nose with no waypoint thrust input. */
  idleAirDrive: boolean;
  /** True when powered drive force can only act along the body's current
   *  forward-facing direction instead of directly along the requested vector. */
  forwardForceRequiresFacing: boolean;
  /** True when non-flying drive force is scaled by the configured
   *  facing-alignment curve before being applied. */
  driveForceScalesWithFacing: boolean;
  /** True when waypoint arrival keeps full directed thrust instead of
   *  braking/slowing at final waypoints or honoring action speed limits. */
  maintainFullThrustAtWaypoints: boolean;
  /** Named, config-authored sampling layout used for air and water
   *  surface-lift distance responses. */
  surfaceProbeSetId: SurfaceProbeSetId;
  /** Named pathfinding profile resolved from pathfindingConfig.json. */
  pathfinding: UnitPathfindingConfig;
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

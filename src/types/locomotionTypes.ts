// Runtime locomotion profile used by movement physics and rendering.

type UnitPathfindingTerrainMode = 'land' | 'anywhere';

export type UnitPathfindingConfig = {
  pathfindingBlueprintId: string;
  terrainMode: UnitPathfindingTerrainMode;
  /** True for profiles that can route over water and steep terrain. */
  ignoreTerrainBlocking: boolean;
  /** Null when terrainMode is `anywhere`; otherwise the slope limit
   *  authored in pathfindingConfig.json. */
  maxSlopeDeg: number | null;
  /** Precomputed cosine threshold for pathfinding against terrain
   *  normals. 0 when terrain blocking is ignored. */
  minSurfaceNormalZ: number;
};

export type UnitLocomotionMediumPhysics = {
  /** Propulsion scalar for this medium, after locomotion-type force scaling. */
  force: number;
  /** Movement authority coefficient for coupling force into directed thrust
   *  and attitude torque in this medium. */
  traction: number;
  /** Passive velocity damping rate for this medium, in 1/s. */
  friction: number;
  /** Constant upward force as a ratio of gravity. Must be in [0, 1). */
  gravityCounterUpwardForceRatio: number;
  /** Height-based upward force coefficient, referenced to the relevant
   *  support surface: terrain/water surface for air, lake bed for water.
   *  Air uses the global distance falloff authored in locomotionConfig.json. */
  heightUpwardForce: number;
  /** Per-tick uniform randomization of `heightUpwardForce`, as a fraction. */
  heightUpwardForceRandomizationAmount: number;
  /** EMA smoothing weight for the final vertical lift force, in [0, 1). */
  heightUpwardForceEMA: number;
};

export type UnitLocomotionPhysics = {
  ground: UnitLocomotionMediumPhysics;
  air: UnitLocomotionMediumPhysics;
  water: UnitLocomotionMediumPhysics;
};

export type UnitLocomotion = {
  type: 'wheels' | 'treads' | 'legs' | 'hover' | 'flying';
  /** Fully-abstracted medium physics. Every unit owns every medium profile;
   *  zero values make a medium inert instead of omitting fields. */
  physics: UnitLocomotionPhysics;
  /** True when powered drive force can only act along the body's current
   *  forward-facing direction instead of directly along the requested vector. */
  forwardForceRequiresFacing: boolean;
  /** True when non-flying drive force is scaled by the configured
   *  facing-alignment curve before being applied. */
  driveForceScalesWithFacing: boolean;
  /** True when waypoint arrival keeps full directed thrust instead of
   *  braking/slowing at final waypoints or honoring action speed limits. */
  maintainFullThrustAtWaypoints: boolean;
  /** Fixed world-space distance for the forward air-lift ground probe. */
  airLiftGroundProbeAheadDistance: number;
  /** Body-radius multiplier added to the forward air-lift ground probe. */
  airLiftGroundProbeAheadRadiusMultiplier: number;
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

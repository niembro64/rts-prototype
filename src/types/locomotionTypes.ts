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

export type UnitLocomotion = {
  type: 'wheels' | 'treads' | 'legs' | 'hover' | 'flying';
  /** Effective propulsion scalar: authored `physics.driveForce` after the
   *  per-locomotion global multiplier from locomotionConfig.json. */
  driveForce: number;
  /** Movement authority coefficient. Ground units use this as terrain
   *  coupling; hover units use it as direct horizontal-thrust authority;
   *  flying units use it as thrust plus turn authority, so low values
   *  produce wider, aircraft-like turns. */
  traction: number;
  /** True when powered drive force can only act along the body's current
   *  forward-facing direction instead of directly along the requested vector. */
  forwardForceRequiresFacing: boolean;
  /** True when non-flying drive force is scaled by the configured
   *  facing-alignment curve before being applied. */
  driveForceScalesWithFacing: boolean;
  /** True when waypoint arrival keeps full directed thrust instead of
   *  braking/slowing at final waypoints or honoring action speed limits. */
  maintainFullThrustAtWaypoints: boolean;
  /** Named pathfinding profile resolved from pathfindingConfig.json. */
  pathfinding: UnitPathfindingConfig;
  /** Hover/flying-only: constant upward force as a ratio of gravity.
   *  0.8 means the locomotion cancels 80% of gravity at every altitude.
   *  Must be < 1 for a finite terrain-following equilibrium. */
  gravityCounterUpwardForceRatio?: number;
  /** Hover/flying-only: inverse-distance ground-effect lift coefficient,
   *  in world units. The force term is m·g·hoverHeightUpwardForce / d,
   *  where d is altitude above terrain. Undefined for ground locomotion. */
  hoverHeightUpwardForce?: number;
  /** Hover/flying-only: per-tick uniform randomization of
   *  `hoverHeightUpwardForce` expressed as a fraction. Each tick the
   *  lift force uses hoverHeightUpwardForce * (1 + U(-amount, +amount)).
   *  Undefined or 0 means no randomization. */
  hoverHeightUpwardForceRandomizationAmount?: number;
  /** Hover/flying-only: EMA smoothing weight on the per-tick (jittered)
   *  hoverHeightUpwardForce. In [0, 1):
   *    smoothed = α · smoothed_prev + (1 − α) · raw
   *  0 (or undefined) disables smoothing. Pairs with the per-unit
   *  `Unit.hoverHeightUpwardForceSmoothed` accumulator. */
  hoverHeightUpwardForceEMA?: number;

  // ── Fully-abstracted medium force profile (ground / air / water) ──
  //
  // `driveForce` + `traction` above are the GROUND drive terms (and the
  // airborne branch reads them as its air thrust). The fields below add the
  // remaining behaviour-preserving slice of the per-medium profile from the
  // design doc ("Locomotion is one fully-abstracted force profile across
  // ground, air, and water"): per-medium passive friction, the full water
  // drive medium, and the swim-lift family. Every term defaults to 0/inert,
  // so a unit that authors none of them moves bit-for-bit as before; a unit
  // specialises into a medium purely by setting its terms non-zero. The full
  // air/ground force-traction split (separate from driveForce/traction) is a
  // future behaviour-changing migration noted in the design doc.

  /** Passive horizontal velocity damping applied while in ground contact, as
   *  an acceleration rate (1/s). 0 = no extra ground drag (current units). */
  groundFriction?: number;
  /** Passive isotropic velocity damping applied while airborne (hover/flying),
   *  as an acceleration rate (1/s). 0 = no air drag (current units). */
  airFriction?: number;
  /** Water medium drive force (analogue of `driveForce` for the submerged
   *  medium). 0 = cannot propel itself in water. Effective drive after the
   *  per-locomotion global multiplier is NOT applied to water terms; they are
   *  authored directly. */
  waterForce?: number;
  /** Water medium traction: couples `waterForce` into directed thrust, the
   *  submerged analogue of `traction`. 0 with a non-zero waterForce yields no
   *  coupled thrust. */
  waterTraction?: number;
  /** Passive isotropic velocity damping applied while submerged (water drag),
   *  as an acceleration rate (1/s). 0 = no water drag. */
  waterFriction?: number;
  /** Swim lift: constant upward force as a ratio of gravity, the water-medium
   *  analogue of `gravityCounterUpwardForceRatio`. Must be < 1. 0 (default) =
   *  pure depth-seeking lift with no constant buoyancy. */
  swimGravityCounterUpwardForceRatio?: number;
  /** Swim lift: depth-seeking upward force that holds a target height above
   *  the lake bed (the same inverse-distance force shape as
   *  `hoverHeightUpwardForce`, referenced to the bed under water). 0 = sinks
   *  (bottom-walker); balanced = neutral mid-column; high = floats. */
  swimHeightUpwardForce?: number;
  /** Swim lift: per-tick uniform randomization of `swimHeightUpwardForce`
   *  expressed as a fraction (mirrors the hover sibling). */
  swimHeightUpwardForceRandomizationAmount?: number;
  /** Swim lift: EMA smoothing weight on the per-tick (jittered)
   *  swimHeightUpwardForce, in [0, 1). Pairs with the per-unit
   *  `Unit.swimHeightUpwardForceSmoothed` accumulator. */
  swimHeightUpwardForceEMA?: number;
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

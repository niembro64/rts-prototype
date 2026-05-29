// Runtime locomotion profile used by movement physics and rendering.

import type { EntityId } from './entityTypes';

export type UnitPathfindingTerrainMode = 'land' | 'anywhere';

export type UnitPathfindingConfig = {
  id: string;
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
  /** Runtime identity for the locomotion subentity mounted under a unit. */
  id: EntityId;
  parentId: EntityId;
  rootHostId: EntityId;
  mountIndex: number;
  type: 'wheels' | 'treads' | 'legs' | 'hover' | 'flying';
  /** Authored propulsion scalar supplied by the locomotion blueprint. */
  driveForce: number;
  /** Ground traction coefficient. This is coupling to terrain, not drag.
   *  For hover units this acts as a horizontal-thrust scalar (no actual
   *  ground contact); 1.0 is full authority. */
  traction: number;
  /** Named pathfinding profile resolved from pathfindingConfig.json. */
  pathfinding: UnitPathfindingConfig;
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
  /** Hover/flying-only: EMA smoothing weight on the per-tick (jittered)
   *  hoverHeight. In [0, 1):
   *    smoothed = α · smoothed_prev + (1 − α) · raw
   *  0 (or undefined) disables smoothing. Pairs with the per-unit
   *  `Unit.hoverHeightSmoothed` accumulator. */
  hoverHeightEMA?: number;
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

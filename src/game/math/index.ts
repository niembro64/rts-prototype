// Math utilities - re-exports

export {
  
  magnitude,
  magnitude3,
  normalizeAngle,
  clamp,
  clamp01,
  angleDeltaAbs,
  lerp,
  lerpAngle,
  getTransformCosSin,
  isFiniteNumber,
  shouldRunOnStride,
} from './MathHelpers';

export {
  lineSphereIntersectionT,
  rayBoxIntersectionT,
} from './CollisionHelpers';

export {
  computeConstantSpeedHomingVelocity,
  computeHomingThrust,
} from './HomingSteering';
export {
  computeTerrainFollowVerticalThrustAccel,
} from './TerrainFollowThrust';

export {
  countBarrels,
  turretBarrelFollowsBeam,
  getBarrelOrbitAngle,
  getConeBarrelBaseOrbitRadius,
  getConeBarrelTipOrbitRadius,
  getSimpleMultiBarrelOrbitRadius,
  getTurretBarrelDiameter,
  getTurretBarrelCenterToTipLength,
  getTurretHeadRadius,
  turretBodyRadiusFromRadius,
  TURRET_BARREL_MIN_DIAMETER,
} from './BarrelGeometry';

export {
  type KinematicInterceptSolution,
  type KinematicState3,
  
  solveKinematicIntercept,
} from './Ballistics';

export { getTurretWorldMount } from './MountGeometry';

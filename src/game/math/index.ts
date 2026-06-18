// Math utilities - re-exports

export {
  distanceSquared,
  distance,
  distanceSquared3,
  distance3,
  magnitude,
  magnitude3,
  normalizeAngle,
  clamp,
  clamp01,
  angleDeltaAbs,
  lerp,
  angleDiff,
  lerpAngle,
  getTransformCosSin,
  integrateDampedRotation,
  isFiniteNumber,
  shouldRunOnStride,
  type DampedRotationOptions,
} from './MathHelpers';

export {
  lineCircleIntersectionT,
  lineSphereIntersectionT,
  lineLineIntersectionT,
  lineRectIntersectionT,
  rayVerticalRectIntersectionT,
  rayTiltedRectIntersectionT,
  rayBoxIntersectionT,
  isPointInSlice,
} from './CollisionHelpers';

export {
  computeConstantSpeedHomingVelocity,
  computeHomingThrust,
  type ConstantSpeedHomingVelocityResult,
  type HomingThrustResult,
} from './HomingSteering';
export {
  computeTerrainFollowVerticalThrustAccel,
  type TerrainFollowVerticalThrustInput,
} from './TerrainFollowThrust';

export {
  type BarrelEndpoint,
  getBarrelTip,
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
  type KinematicInterceptInput,
  type KinematicInterceptSolution,
  type KinematicState3,
  type KinematicVec3,
  type TurretShotAngleInput,
  type TurretShotAngleSolution,
  type TurretShotArcPreference,
  computeInterceptTime,
  integrateConstantAccelerationPosition,
  integrateConstantAccelerationVelocity,
  solveKinematicIntercept,
  solveTurretShotAngles,
} from './Ballistics';

export { getTurretWorldMount } from './MountGeometry';

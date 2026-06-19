// Math utilities - re-exports

export {
  
  distance,
  
  
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
  type DampedRotationOptions,
} from './MathHelpers';

export {
  
  lineSphereIntersectionT,
  
  
  
  
  rayBoxIntersectionT,
  
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
  
  
  
  solveKinematicIntercept,
  
} from './Ballistics';

export { getTurretWorldMount } from './MountGeometry';

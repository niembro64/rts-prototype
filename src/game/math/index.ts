// Math utilities - re-exports

export {
  
  magnitude,
  magnitude3,
  normalizeAngle,
  clamp,
  clamp01,
  clampUnit,
  smoothstep01,
  angleDeltaAbs,
  lerp,
  lerpAngle,
  getTransformCosSin,
  isFiniteNumber,
  finiteOr,
  finiteOrZero,
  shouldRunOnStride,
} from './MathHelpers';

export {
  lineSphereIntersectionT,
  rayBoxIntersectionT,
  rayBoxIntersectionTWithDelta,
} from './CollisionHelpers';

export {
  computeConstantSpeedHomingVelocity,
  computeHomingThrust,
} from './HomingSteering';
export {
  computeTerrainFollowVerticalThrustAccel,
} from './TerrainFollowThrust';

export {
  getBarrelOrbitAngle,
  getConeBarrelBaseOrbitRadius,
  getConeBarrelTipOrbitRadius,
  getSimpleMultiBarrelOrbitRadius,
  getMultiBarrelFiringOrbitRadius,
  getTurretBarrelDiameter,
  getTurretBarrelCenterToTipLength,
  getTurretHeadRadius,
  TURRET_BARREL_MIN_DIAMETER,
} from './BarrelGeometry';

export {
  type KinematicInterceptSolution,
  type KinematicState3,
  
  solveKinematicIntercept,
} from './Ballistics';

export { getTurretWorldMount } from './MountGeometry';

export { linearToSrgbByte } from './ColorMath';

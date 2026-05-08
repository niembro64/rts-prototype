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

export { applyHomingSteering } from './HomingSteering';

export {
  type BarrelEndpoint,
  getBarrelTip,
  countBarrels,
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
  type BallisticSolution,
  ballisticSolutions,
  solveBallisticPitch,
  computeInterceptTime,
} from './Ballistics';

export { getTurretWorldMount } from './MountGeometry';
